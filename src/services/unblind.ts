import type { DB } from "../db.js";
import { err } from "../errors.js";
import { audit } from "../audit.js";
import type { Ctx } from "../context.js";
import { getSubject } from "./subject.js";

export function getUserRole(db: DB, name: string): string {
  const u = db.prepare("SELECT role FROM users WHERE name = ?").get(name) as
    | { role: string }
    | undefined;
  if (!u) throw err.notFound(`user '${name}' not found`);
  return u.role;
}

/** Blinded roles must never see arm assignments. */
export function assertCanViewArm(db: DB, actor: string): void {
  const role = getUserRole(db, actor);
  if (role === "blinded" || role === "operator")
    throw err.blinded(`role '${role}' may not view treatment assignments`);
}

/**
 * Unblind a single subject. Requires unblinded/admin role; emergency
 * unblinding is flagged and written to the dedicated unblinding audit chain.
 */
export function unblindSubject(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; reason: string; emergency: boolean; actor: string }
): { arm: string } {
  const role = getUserRole(db, input.actor);
  if (role !== "unblinded" && role !== "admin")
    throw err.blinded(`role '${role}' may not unblind`);
  getSubject(db, input.subjectId);
  const a = db
    .prepare("SELECT arm FROM assignments WHERE subject_id = ?")
    .get(input.subjectId) as { arm: string } | undefined;
  if (!a) throw err.state("subject has no assignment");
  db.prepare(
    "INSERT INTO unblindings (subject_id, requested_by, reason, emergency, created_at) VALUES (?,?,?,?,?)"
  ).run(input.subjectId, input.actor, input.reason, input.emergency ? 1 : 0, ctx.now().toISOString());
  audit(db, { chain: "unblinding", actor: input.actor, action: input.emergency ? "unblind.emergency" : "unblind.planned", entity: "subject", entityId: String(input.subjectId), detail: { reason: input.reason } }, ctx.now());
  return { arm: a.arm };
}
