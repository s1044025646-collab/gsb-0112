import express, { type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { DB } from "./db.js";
import type { Ctx } from "./context.js";
import { AppError, err } from "./errors.js";
import * as trialSvc from "./services/trial.js";
import * as subjectSvc from "./services/subject.js";
import * as visitSvc from "./services/visit.js";
import * as unblindSvc from "./services/unblind.js";
import { verifyChain } from "./audit.js";

function paginate(req: Request): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  return { limit, offset };
}

function paged(db: DB, sql: string, countSql: string, params: any[], req: Request) {
  const { limit, offset } = paginate(req);
  const total = (db.prepare(countSql).get(...params) as any).c as number;
  const rows = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  return { data: rows, meta: { total, limit, offset } };
}

const actorOf = (req: Request): string => {
  const actor = req.header("x-actor");
  if (!actor) throw err.validation("missing x-actor header");
  return actor;
};

export function createApp(db: DB, ctx: Ctx) {
  const app = express();
  app.use(express.json());

  const handle = (fn: (req: Request) => unknown, status = 200) =>
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const out = fn(req);
        res.status(status).json(out);
      } catch (e) {
        next(e);
      }
    };

  // ---- trials / protocol / sites / users ----
  app.post("/trials", handle((req) => {
    const b = z.object({
      code: z.string().min(1),
      title: z.string().min(1),
      arms: z.array(z.string().min(1)).min(1),
      blockSize: z.number().int().positive(),
      actor: z.string().min(1),
    }).parse(req.body);
    return trialSvc.createTrial(db, ctx, b);
  }, 201));

  app.post("/trials/:id/protocol-versions", handle((req) => {
    const b = z.object({
      version: z.string().min(1),
      effectiveFrom: z.string().datetime(),
      visitWindows: z.array(z.object({
        name: z.string(),
        target_day: z.number().int(),
        minus_days: z.number().int().nonnegative(),
        plus_days: z.number().int().nonnegative(),
      })),
      actor: z.string().min(1),
    }).parse(req.body);
    return trialSvc.addProtocolVersion(db, ctx, { trialId: Number(req.params.id), ...b });
  }, 201));

  app.post("/trials/:id/sites", handle((req) => {
    const b = z.object({
      code: z.string().min(1),
      name: z.string().min(1),
      timezone: z.string().min(1),
      actor: z.string().min(1),
    }).parse(req.body);
    return trialSvc.addSite(db, ctx, { trialId: Number(req.params.id), ...b });
  }, 201));

  app.post("/users", handle((req) => {
    const b = z.object({
      name: z.string().min(1),
      role: z.enum(["operator", "blinded", "unblinded", "admin"]),
    }).parse(req.body);
    return trialSvc.addUser(db, b.name, b.role);
  }, 201));

  // ---- subjects / screening / consent ----
  app.post("/subjects", handle((req) => {
    const b = z.object({
      trialId: z.number().int(),
      siteId: z.number().int(),
      anonCode: z.string().min(1),
      stratum: z.record(z.string()),
      actor: z.string().min(1),
    }).parse(req.body);
    return subjectSvc.registerSubject(db, ctx, b);
  }, 201));

  app.get("/subjects", handle((req) => {
    const actor = actorOf(req);
    const blinded = ["blinded", "operator"].includes(
      (db.prepare("SELECT role FROM users WHERE name = ?").get(actor) as any)?.role ?? "operator"
    );
    const { limit, offset } = paginate(req);
    const total = (db.prepare("SELECT COUNT(*) c FROM subjects").get() as any).c;
    const rows = db.prepare(
      `SELECT s.id, s.anon_code, s.status, s.stratum, s.site_id, s.created_at
       ${blinded ? "" : ", (SELECT arm FROM assignments a WHERE a.subject_id = s.id) AS arm"}
       FROM subjects s ORDER BY s.id LIMIT ? OFFSET ?`
    ).all(limit, offset);
    return { data: rows, meta: { total, limit, offset, blinded } };
  }));

  app.post("/subjects/:id/screening", handle((req) => {
    const b = z.object({
      criteria: z.record(z.boolean()),
      eligible: z.boolean(),
      actor: z.string().min(1),
    }).parse(req.body);
    return subjectSvc.recordScreening(db, ctx, { subjectId: Number(req.params.id), ...b });
  }, 201));

  app.post("/subjects/:id/consent", handle((req) => {
    const b = z.object({
      consentVersion: z.string().min(1),
      signedAt: z.string().datetime().optional(),
      actor: z.string().min(1),
    }).parse(req.body);
    return subjectSvc.recordConsent(db, ctx, { subjectId: Number(req.params.id), ...b });
  }, 201));

  // ---- randomization ----
  app.post("/subjects/:id/assign", handle((req) => {
    const b = z.object({ actor: z.string().min(1) }).parse(req.body);
    return subjectSvc.assignSubject(db, ctx, { subjectId: Number(req.params.id), actor: b.actor });
  }, 201));

  app.post("/subjects/:id/withdraw", handle((req) => {
    const b = z.object({ reason: z.string().min(1), actor: z.string().min(1) }).parse(req.body);
    subjectSvc.withdrawSubject(db, ctx, { subjectId: Number(req.params.id), ...b });
    return { ok: true };
  }));

  app.post("/subjects/:id/misrandomization", handle((req) => {
    const b = z.object({ detail: z.string().min(1), actor: z.string().min(1) }).parse(req.body);
    subjectSvc.reportMisrandomization(db, ctx, { subjectId: Number(req.params.id), ...b });
    return { ok: true };
  }, 201));

  // Arm reveal endpoint: role-guarded.
  app.get("/subjects/:id/arm", handle((req) => {
    const actor = actorOf(req);
    unblindSvc.assertCanViewArm(db, actor);
    const a = db.prepare("SELECT arm, assigned_at FROM assignments WHERE subject_id = ?")
      .get(Number(req.params.id)) as any;
    if (!a) throw err.notFound("no assignment for subject");
    return a;
  }));

  // ---- visits / deviations ----
  app.post("/subjects/:id/visits", handle((req) => {
    const b = z.object({
      visitName: z.string().min(1),
      occurredAt: z.string().datetime(),
      actor: z.string().min(1),
    }).parse(req.body);
    return visitSvc.recordVisit(db, ctx, { subjectId: Number(req.params.id), ...b });
  }, 201));

  app.get("/visits", handle((req) =>
    paged(db, "SELECT * FROM visits ORDER BY id", "SELECT COUNT(*) c FROM visits", [], req)
  ));

  app.post("/subjects/:id/deviations", handle((req) => {
    const b = z.object({
      type: z.string().min(1),
      description: z.string().min(1),
      actor: z.string().min(1),
    }).parse(req.body);
    return visitSvc.reportDeviation(db, ctx, { subjectId: Number(req.params.id), ...b });
  }, 201));

  app.get("/deviations", handle((req) =>
    paged(db, "SELECT * FROM deviations ORDER BY id", "SELECT COUNT(*) c FROM deviations", [], req)
  ));

  // ---- unblinding ----
  app.post("/subjects/:id/unblind", handle((req) => {
    const b = z.object({
      reason: z.string().min(1),
      emergency: z.boolean().default(false),
      actor: z.string().min(1),
    }).parse(req.body);
    return unblindSvc.unblindSubject(db, ctx, { subjectId: Number(req.params.id), ...b });
  }));

  // ---- audit ----
  app.get("/audit", handle((req) => {
    const chain = String(req.query.chain ?? "main");
    return paged(
      db,
      "SELECT * FROM audit_log WHERE chain = ? ORDER BY id",
      "SELECT COUNT(*) c FROM audit_log WHERE chain = ?",
      [chain],
      req
    );
  }));

  app.get("/audit/summary", handle(() => {
    const chains = ["main", "withdrawal", "misrandomization", "unblinding"] as const;
    const out: Record<string, { entries: number; intact: boolean }> = {};
    for (const c of chains) {
      const n = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE chain = ?").get(c) as any).c;
      out[c] = { entries: n, intact: verifyChain(db, c) };
    }
    const counts = {
      trials: (db.prepare("SELECT COUNT(*) c FROM trials").get() as any).c,
      subjects: (db.prepare("SELECT COUNT(*) c FROM subjects").get() as any).c,
      assignments: (db.prepare("SELECT COUNT(*) c FROM assignments").get() as any).c,
      deviations: (db.prepare("SELECT COUNT(*) c FROM deviations").get() as any).c,
      unblindings: (db.prepare("SELECT COUNT(*) c FROM unblindings").get() as any).c,
    };
    return { chains: out, counts };
  }));

  // ---- errors ----
  app.use((e: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (e instanceof z.ZodError) {
      res.status(400).json({ error: { code: "VALIDATION_ERROR", message: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } });
      return;
    }
    if (e instanceof AppError) {
      res.status(e.httpStatus).json({ error: { code: e.code, message: e.message } });
      return;
    }
    res.status(500).json({ error: { code: "INTERNAL", message: String(e) } });
  });

  return app;
}
