import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AuditEntryInput {
  entityType: string;
  entityId: string;
  action: string;
  payload: unknown;
  operatorId?: string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashEntry(prevHash: string | null, line: string): string {
  return createHash("sha256").update(`${prevHash ?? "GENESIS"}|${line}`).digest("hex");
}

export function appendAudit(
  db: DatabaseSync,
  input: AuditEntryInput,
  nowIso: string,
): { id: number; hash: string } {
  const last = db
    .prepare("SELECT id, chain_hash AS hash FROM audit_log ORDER BY id DESC LIMIT 1")
    .get() as { id: number; hash: string } | undefined;
  const line = canonicalJson({
 t: input.entityType,
    id: input.entityId,
    a: input.action,
    p: input.payload,
    op: input.operatorId ?? null,
    at: nowIso,
  });
  const hash = hashEntry(last?.hash ?? null, line);
  const info = db
    .prepare(
      `INSERT INTO audit_log(chain_prev, chain_hash, entity_type, entity_id, action, payload_json, operator_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(last?.hash ?? null, hash, input.entityType, input.entityId, input.action, line, input.operatorId ?? null, nowIso);
  return { id: Number(info.lastInsertRowid), hash };
}

export function verifyAuditChain(db: DatabaseSync): { ok: boolean; brokenAtId?: number; count: number } {
  const rows = db
    .prepare("SELECT id, chain_prev AS prev, chain_hash AS hash, payload_json AS line FROM audit_log ORDER BY id")
    .all() as { id: number; prev: string | null; hash: string; line: string }[];
  let expectedPrev: string | null = null;
  for (const row of rows) {
    if ((row.prev ?? null) !== expectedPrev) return { ok: false, brokenAtId: row.id, count: rows.length };
    const recomputed = hashEntry(expectedPrev, row.line);
    if (recomputed !== row.hash) return { ok: false, brokenAtId: row.id, count: rows.length };
    expectedPrev = row.hash;
  }
  return { ok: true, count: rows.length };
}
