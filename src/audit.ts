import { createHash } from "node:crypto";
import type { DB } from "./db.js";

export type AuditChain = "main" | "withdrawal" | "misrandomization" | "unblinding";

export interface AuditEntry {
  chain: AuditChain;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  detail: unknown;
}

/**
 * Append a hash-chained audit record. Each chain (main / withdrawal /
 * misrandomization / unblinding) links independently so events like
 * withdrawal, mis-randomization and emergency unblinding keep their own
 * tamper-evident history.
 */
export function audit(db: DB, e: AuditEntry, now: Date): void {
  const prev = db
    .prepare("SELECT hash FROM audit_log WHERE chain = ? ORDER BY id DESC LIMIT 1")
    .get(e.chain) as { hash: string } | undefined;
  const prevHash = prev?.hash ?? "GENESIS";
  const payload = JSON.stringify({
    chain: e.chain,
    actor: e.actor,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    detail: e.detail,
    prevHash,
    at: now.toISOString(),
  });
  const hash = createHash("sha256").update(payload).digest("hex");
  db.prepare(
    `INSERT INTO audit_log (chain, actor, action, entity, entity_id, detail, prev_hash, hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    e.chain,
    e.actor,
    e.action,
    e.entity,
    e.entityId,
    JSON.stringify(e.detail ?? {}),
    prevHash,
    hash,
    now.toISOString()
  );
}

export function verifyChain(db: DB, chain: AuditChain): boolean {
  const rows = db
    .prepare("SELECT * FROM audit_log WHERE chain = ? ORDER BY id")
    .all(chain) as any[];
  let prevHash = "GENESIS";
  for (const r of rows) {
    const payload = JSON.stringify({
      chain: r.chain,
      actor: r.actor,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      detail: JSON.parse(r.detail),
      prevHash,
      at: r.created_at,
    });
    const hash = createHash("sha256").update(payload).digest("hex");
    if (hash !== r.hash || r.prev_hash !== prevHash) return false;
    prevHash = r.hash;
  }
  return true;
}
