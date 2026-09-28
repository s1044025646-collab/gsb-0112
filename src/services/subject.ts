import type { DB } from "../db.js";
import { tx } from "../db.js";
import { err } from "../errors.js";
import { audit } from "../audit.js";
import type { Ctx } from "../context.js";
import { getTrial } from "./trial.js";
import { ensurePool, consumeNext } from "./randomize.js";

export function stratumKey(stratum: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(stratum).sort(([a], [b]) => a.localeCompare(b)))
  );
}

export function getSubject(db: DB, id: number): any {
  const s = db.prepare("SELECT * FROM subjects WHERE id = ?").get(id);
  if (!s) throw err.notFound(`subject ${id} not found`);
  return s;
}

/** Register an anonymous subject in screening. No PII accepted. */
export function registerSubject(
  db: DB,
  ctx: Ctx,
  input: {
    trialId: number;
    siteId: number;
    anonCode: string;
    stratum: Record<string, string>;
    actor: string;
  }
): { id: number } {
  getTrial(db, input.trialId);
  const site = db
    .prepare("SELECT * FROM sites WHERE id = ? AND trial_id = ?")
    .get(input.siteId, input.trialId);
  if (!site) throw err.notFound(`site ${input.siteId} not found in trial ${input.trialId}`);
  if (/[@]|\d{11,}/.test(input.anonCode))
    throw err.validation("anon_code must not contain identifiable data");
  const dup = db.prepare("SELECT id FROM subjects WHERE anon_code = ?").get(input.anonCode);
  if (dup) throw err.conflict(`anon_code ${input.anonCode} already registered`);
  const r = db
    .prepare(
      "INSERT INTO subjects (trial_id, site_id, anon_code, stratum, status, created_at) VALUES (?,?,?,?, 'screening', ?)"
    )
    .run(
      input.trialId,
      input.siteId,
      input.anonCode,
      JSON.stringify(input.stratum),
      ctx.now().toISOString()
    );
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "subject.register", entity: "subject", entityId: String(id), detail: { anonCode: input.anonCode, stratum: input.stratum } }, ctx.now());
  return { id };
}

export function recordScreening(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; criteria: Record<string, boolean>; eligible: boolean; actor: string }
): { id: number } {
  const s = getSubject(db, input.subjectId);
  if (s.status !== "screening" && s.status !== "eligible")
    throw err.state(`cannot screen subject in status ${s.status}`);
  const r = db
    .prepare("INSERT INTO screenings (subject_id, criteria, eligible, recorded_at) VALUES (?,?,?,?)")
    .run(input.subjectId, JSON.stringify(input.criteria), input.eligible ? 1 : 0, ctx.now().toISOString());
  db.prepare("UPDATE subjects SET status = ? WHERE id = ?").run(
    input.eligible ? "eligible" : "screen_failed",
    input.subjectId
  );
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "subject.screen", entity: "subject", entityId: String(input.subjectId), detail: { eligible: input.eligible } }, ctx.now());
  return { id };
}

export function recordConsent(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; consentVersion: string; signedAt?: string; actor: string }
): { id: number } {
  getSubject(db, input.subjectId);
  const r = db
    .prepare("INSERT INTO consents (subject_id, consent_version, signed_at) VALUES (?,?,?)")
    .run(input.subjectId, input.consentVersion, input.signedAt ?? ctx.now().toISOString());
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "subject.consent", entity: "subject", entityId: String(input.subjectId), detail: { consentVersion: input.consentVersion } }, ctx.now());
  return { id };
}

function hasActiveConsent(db: DB, subjectId: number, now: Date): boolean {
  const c = db
    .prepare(
      `SELECT id FROM consents
       WHERE subject_id = ? AND withdrawn_at IS NULL AND signed_at <= ?
       ORDER BY signed_at DESC LIMIT 1`
    )
    .get(subjectId, now.toISOString());
  return !!c;
}

/**
 * Assign a subject to an arm via permuted-block randomization.
 * Refuses when eligibility or consent is missing. Runs in one transaction
 * so concurrent assignments cannot take the same slot.
 */
export function assignSubject(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; actor: string }
): { arm: string; seqNo: number } {
  return tx(db, () => {
    const s = getSubject(db, input.subjectId);
    if (s.status === "assigned") throw err.state("subject already assigned");
    if (s.status === "withdrawn")
      throw err.state("subject withdrawn; create a new anonymous record for re-entry");
    if (s.status !== "eligible")
      throw err.eligibility("subject is not eligible (screening incomplete or failed)");
    if (!hasActiveConsent(db, input.subjectId, ctx.now()))
      throw err.consent("no active informed consent on record");

    const trial = getTrial(db, s.trial_id);
    const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(s.site_id) as any;
    const key = stratumKey(JSON.parse(s.stratum));
    ensurePool(db, trial, s.site_id, site.code, key, 1);
    const slot = consumeNext(db, s.trial_id, s.site_id, key, input.subjectId, ctx.now());
    if (!slot) throw err.pool("no randomization slot available");

    db.prepare(
      "INSERT INTO assignments (subject_id, sequence_id, arm, assigned_at) VALUES (?,?,?,?)"
    ).run(input.subjectId, slot.sequenceId, slot.arm, ctx.now().toISOString());
    db.prepare("UPDATE subjects SET status = 'assigned' WHERE id = ?").run(input.subjectId);
    audit(db, { chain: "main", actor: input.actor, action: "subject.assign", entity: "subject", entityId: String(input.subjectId), detail: { seqNo: slot.seqNo, stratum: key } }, ctx.now());
    return { arm: slot.arm, seqNo: slot.seqNo };
  });
}

/** Withdraw a subject. The consumed randomization number is never recycled. */
export function withdrawSubject(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; reason: string; actor: string }
): void {
  tx(db, () => {
    const s = getSubject(db, input.subjectId);
    if (s.status === "withdrawn") throw err.state("already withdrawn");
    db.prepare("UPDATE subjects SET status = 'withdrawn' WHERE id = ?").run(input.subjectId);
    db.prepare(
      "UPDATE consents SET withdrawn_at = ? WHERE subject_id = ? AND withdrawn_at IS NULL"
    ).run(ctx.now().toISOString(), input.subjectId);
    audit(db, { chain: "withdrawal", actor: input.actor, action: "subject.withdraw", entity: "subject", entityId: String(input.subjectId), detail: { reason: input.reason } }, ctx.now());
  });
}

/** Flag a mis-randomization; keeps its own audit chain. */
export function reportMisrandomization(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; detail: string; actor: string }
): void {
  const s = getSubject(db, input.subjectId);
  audit(db, { chain: "misrandomization", actor: input.actor, action: "subject.misrandomized", entity: "subject", entityId: String(input.subjectId), detail: { note: input.detail, status: s.status } }, ctx.now());
}
