import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppContext } from "../app/context.ts";
import { DomainError } from "../domain/errors.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { ensureOperator, roleOf, type OperatorRole } from "../services/operator-service.ts";
import { registerScreen, withdrawConsent } from "../services/subject-service.ts";
import { allocate, maskedAllocation, unblind, markRandomizedInError } from "../services/randomization-service.ts";
import { scheduleVisit, recordVisit, reportManualDeviation, listDeviations } from "../services/visit-service.ts";

interface RouteContext {
  app: AppContext;
  operatorId?: string;
  role?: OperatorRole;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new DomainError("PAYLOAD_TOO_LARGE", "body exceeds 1MB", 413));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new DomainError("INVALID_JSON", "request body is not valid JSON", 400));
      }
    });
    req.on("error", reject);
  });
}

function asObject(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new DomainError("VALIDATION_ERROR", "object body required", 422);
  return v as Record<string, unknown>;
}
function str(body: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) throw new DomainError("VALIDATION_ERROR", `${key} must be a non-empty string`, 422);
  if (pattern && !pattern.test(v)) throw new DomainError("VALIDATION_ERROR", `${key} has invalid format`, 422);
  return v;
}
function num(body: Record<string, unknown>, key: string): number {
  const v = body[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new DomainError("VALIDATION_ERROR", `${key} must be a number`, 422);
  return v;
}
function boolMap(body: Record<string, unknown>, key: string): Record<string, boolean> {
  const v = body[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new DomainError("VALIDATION_ERROR", `${key} must be an object`, 422);
  const out: Record<string, boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "boolean") throw new DomainError("VALIDATION_ERROR", `${key}.${k} must be boolean`, 422);
    out[k] = val;
  }
  return out;
}
function strMap(body: Record<string, unknown>, key: string): Record<string, string> {
  const v = body[key];
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new DomainError("VALIDATION_ERROR", `${key} must be an object`, 422);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") throw new DomainError("VALIDATION_ERROR", `${key}.${k} must be string`, 422);
    out[k] = val;
  }
  return out;
}
function dateParam(body: Record<string, unknown>, key: string): Date {
  const s = str(body, key);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new DomainError("VALIDATION_ERROR", `${key} must be ISO-8601`, 422);
  return d;
}

function pagination(url: URL): { limit: number; offset: number } {
  const limitRaw = url.searchParams.get("limit") ?? "50";
  const offsetRaw = url.searchParams.get("offset") ?? "0";
  const limit = Number(limitRaw);
  const offset = Number(offsetRaw);
  if (!Number.isInteger(limit) || !Number.isInteger(offset) || limit < 1 || offset < 0) {
    throw new DomainError("VALIDATION_ERROR", "limit must be a positive integer and offset a non-negative integer", 422);
  }
  return { limit, offset };
}

export function createApiServer(app: AppContext): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/health") return json(res, 200, { status: "ok" });

      const username = req.headers["x-operator"];
      const roleHeader = req.headers["x-role"];
      let rc: RouteContext = { app };
      if (typeof username === "string" && typeof roleHeader === "string") {
        if (!["coordinator", "unblinded_admin", "auditor"].includes(roleHeader)) {
          throw new DomainError("VALIDATION_ERROR", "x-role invalid", 422);
        }
        const operatorId = ensureOperator(app, username, roleHeader as OperatorRole);
        if (roleOf(app, operatorId) !== roleHeader) {
          throw new DomainError("FORBIDDEN", "operator already registered with a different role", 403);
        }
        rc = { app, operatorId, role: roleHeader as OperatorRole };
      }

      const ctx = () => ({ ...app, operatorId: rc.operatorId });
      const requireRole = (role: OperatorRole) => {
        if (rc.role !== role) throw new DomainError("FORBIDDEN", `requires role ${role}`, 403);
      };
      const requireAuth = () => {
        if (!rc.operatorId) throw new DomainError("FORBIDDEN", "x-operator and x-role headers required", 401);
      };

      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/screenings") {
        requireAuth();
        const body = asObject(await readJson(req));
        const result = registerScreen(ctx(), {
          trialCode: str(body, "trialCode", /^[A-Z0-9_-]{2,20}$/),
          siteCode: str(body, "siteCode", /^[A-Z0-9]{2,10}$/),
          strata: strMap(body, "strata"),
          criteria: boolMap(body, "criteria"),
          consentSignedAt: dateParam(body, "consentSignedAt"),
        });
        return json(res, 201, result);
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/allocate$/.test(url.pathname)) {
        requireAuth();
        const subjectId = url.pathname.split("/")[2]!;
        const result = allocate(ctx(), subjectId);
        const masked = rc.role === "unblinded_admin" ? result : { ...result, arm: undefined };
        return json(res, 201, masked);
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/withdraw$/.test(url.pathname)) {
        requireAuth();
        const subjectId = url.pathname.split("/")[2]!;
        withdrawConsent(ctx(), subjectId);
        return json(res, 200, { status: "withdrawn" });
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/randomized-in-error$/.test(url.pathname)) {
        requireRole("unblinded_admin");
        const subjectId = url.pathname.split("/")[2]!;
        const body = asObject(await readJson(req));
        markRandomizedInError(ctx(), subjectId, str(body, "justification"));
        return json(res, 200, { status: "randomized_in_error" });
      }

      if (method === "GET" && /^\/subjects\/[^/]+\/allocation$/.test(url.pathname)) {
        requireAuth();
        const subjectId = url.pathname.split("/")[2]!;
        if (rc.role === "unblinded_admin") {
          const row = app.db.prepare(
            `SELECT a.*, s.anon_code FROM allocations a JOIN subjects s ON s.id = a.subject_id
             WHERE a.subject_id = ? ORDER BY a.allocated_at DESC LIMIT 1`,
          ).get(subjectId);
          if (!row) throw new DomainError("NOT_FOUND", "allocation not found", 404);
          return json(res, 200, row);
        }
        return json(res, 200, maskedAllocation(ctx(), subjectId));
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/unblind$/.test(url.pathname)) {
        requireRole("unblinded_admin");
        const subjectId = url.pathname.split("/")[2]!;
        const body = asObject(await readJson(req));
        const reason = str(body, "reason", /^(emergency|authorized_export)$/) as "emergency" | "authorized_export";
        const result = unblind(ctx(), subjectId, str(body, "justification"), reason, "unblinded_admin");
        return json(res, 201, result);
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/visits\/[^/]+\/schedule$/.test(url.pathname)) {
        requireAuth();
        const parts = url.pathname.split("/");
        const subjectId = parts[2]!;
        const visitCode = parts[4]!;
        const body = asObject(await readJson(req));
        const result = scheduleVisit(ctx(), subjectId, visitCode, dateParam(body, "baselineAt"));
        return json(res, 201, result);
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/visits\/[^/]+\/record$/.test(url.pathname)) {
        requireAuth();
        const parts = url.pathname.split("/");
        const subjectId = parts[2]!;
        const visitCode = parts[4]!;
        const body = asObject(await readJson(req));
        const result = recordVisit(ctx(), subjectId, visitCode, dateParam(body, "occurredAt"));
        return json(res, 201, result);
      }

      if (method === "POST" && /^\/subjects\/[^/]+\/deviations$/.test(url.pathname)) {
        requireAuth();
        const subjectId = url.pathname.split("/")[2]!;
        const body = asObject(await readJson(req));
        const id = reportManualDeviation(ctx(), subjectId, str(body, "kind", /^[a-z0-9_]{3,40}$/), str(body, "detail"), dateParam(body, "eventAt"));
        return json(res, 201, { deviationId: id });
      }

      if (method === "GET" && url.pathname === "/deviations") {
        requireAuth();
        const { limit: rawLimit, offset: rawOffset } = pagination(url);
        const limit = Math.min(rawLimit, 200);
        const offset = rawOffset;
        const trialId = url.searchParams.get("trialId") ?? undefined;
        const page = listDeviations(app.db, { trialId, limit, offset });
        return json(res, 200, { data: page.rows, total: page.total, limit, offset });
      }

      if (method === "GET" && url.pathname === "/subjects") {
        requireAuth();
        const { limit: rawLimit, offset } = pagination(url);
        const limit = Math.min(rawLimit, 200);
        const rows = app.db.prepare(
          "SELECT id, anon_code AS anonCode, status, stratum_signature AS stratumSignature, created_at AS createdAt FROM subjects ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
        ).all(limit, offset);
        const total = (app.db.prepare("SELECT COUNT(*) AS c FROM subjects").get() as { c: number }).c;
        return json(res, 200, { data: rows, total, limit, offset });
      }

      if (method === "GET" && url.pathname === "/audit/verify") {
        requireRole("auditor");
        return json(res, 200, verifyAuditChain(app.db));
      }

      if (method === "GET" && url.pathname === "/audit") {
        requireRole("auditor");
        const { limit: rawLimit, offset } = pagination(url);
        const limit = Math.min(rawLimit, 500);
        const rows = app.db.prepare(
          "SELECT id, entity_type AS entityType, entity_id AS entityId, action, operator_id AS operatorId, created_at AS createdAt FROM audit_log ORDER BY id LIMIT ? OFFSET ?",
        ).all(limit, offset);
        const total = (app.db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c;
        return json(res, 200, { data: rows, total, limit, offset });
      }

      return json(res, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
    } catch (err) {
      if (err instanceof DomainError) return json(res, err.httpStatus, { error: { code: err.code, message: err.message } });
      const message = err instanceof Error ? err.message : "internal error";
      return json(res, 500, { error: { code: "INTERNAL", message } });
    }
  });
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  return server;
}
