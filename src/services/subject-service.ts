import type { DatabaseSync } from "node:sqlite";
import { newId, anonCode, stratumSignature } from "../domain/ids.ts";
import { ERR } from "../domain/errors.ts";
import { appendAudit } from "../domain/audit.ts";
import { withTransaction } from "../db/database.ts";
import type { TrialContext } from "./trial-service.ts";

export interface ScreenInput {
  trialCode: string;
  siteCode: string;
  strata: Record<string, string>;
  criteria: Record<string, boolean>;
  consentSignedAt: Date;
}

export interface ScreenResult {
  subjectId: string;
  anonCode: string;
  eligible: boolean;
  consentGiven: boolean;
  failedCriteria: string[];
}

export function registerScreen(ctx: TrialContext, input: ScreenInput): ScreenResult {
  const trial = ctx.db.prepare("SELECT * FROM trials WHERE code = ?").get(input.trialCode) as
    | { id: string; current_protocol_version_id: string }
    | undefined;
  if (!trial) throw ERR.notFound(`trial ${input.trialCode}`);
  const site = ctx.db.prepare("SELECT * FROM sites WHERE trial_id = ? AND code = ?").get(trial.id, input.siteCode) as
    | { id: string }
    | undefined;
  if (!site) throw ERR.notFound(`site ${input.siteCode}`);

  const definedStrata = ctx.db.prepare("SELECT factor_key, factor_value FROM strata WHERE trial_id = ?").all(trial.id) as {
    factor_key: string;
    factor_value: string;
  }[];
  const factorMap = new Map<string, Set<string>>();
  for (const s of definedStrata) {
    if (!factorMap.has(s.factor_key)) factorMap.set(s.factor_key, new Set());
    factorMap.get(s.factor_key)!.add(s.factor_value);
  }
  for (const key of factorMap.keys()) {
    const value = input.strata[key];
    if (value === undefined || !factorMap.get(key)!.has(value)) {
      throw ERR.validation(`stratum factor "${key}" missing or value not allowed`);
    }
  }
  for (const key of Object.keys(input.strata)) {
    if (!factorMap.has(key)) throw ERR.validation(`unknown stratum factor "${key}"`);
  }

  const failed = Object.entries(input.criteria).filter(([, v]) => v !== true).map(([k]) => k);
  const eligible = failed.length === 0;
  const now = ctx.clock.now();
  const nowIso = now.toISOString();
  if (input.consentSignedAt.getTime() > now.getTime()) throw ERR.validation("consent signature cannot be in the future");
  const consentGiven = input.consentSignedAt.getTime() <= now.getTime();

  return withTransaction(ctx.db, () => {
    const seqRow = ctx.db
      .prepare("SELECT COUNT(*) AS c FROM subjects WHERE trial_id = ? AND site_id = ?")
      .get(trial!.id, site!.id) as { c: number };
    let code = anonCode(input.siteCode, seqRow.c + 1);
    while (ctx.db.prepare("SELECT 1 FROM subjects WHERE trial_id=? AND anon_code=?").get(trial!.id, code)) {
      code = anonCode(input.siteCode, seqRow.c + 1 + Math.floor(Math.random() * 1e6));
    }
    const subjectId = newId();
    const signature = stratumSignature(input.strata);
    ctx.db.prepare(
      "INSERT INTO subjects(id, trial_id, site_id, anon_code, status, stratum_signature, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run(subjectId, trial!.id, site!.id, code, "screened", signature, nowIso);
    ctx.db.prepare(
      "INSERT INTO eligibility_results(id, subject_id, protocol_version_id, passed, criteria_json, decided_at) VALUES (?,?,?,?,?,?)",
    ).run(newId(), subjectId, trial!.current_protocol_version_id, eligible ? 1 : 0, JSON.stringify(input.criteria), nowIso);
    ctx.db.prepare(
      "INSERT INTO consent_events(id, subject_id, kind, signed_at, recorded_at) VALUES (?,?,?,?,?)",
    ).run(newId(), subjectId, "given", input.consentSignedAt.toISOString(), nowIso);
    appendAudit(ctx.db, { entityType: "subject", entityId: subjectId, action: "screened", payload: { anonCode: code, eligible, consentGiven, failedCriteria: failed }, operatorId: ctx.operatorId }, nowIso);
    return { subjectId, anonCode: code, eligible, consentGiven, failedCriteria: failed };
  });
}

export function withdrawConsent(ctx: TrialContext, subjectId: string): void {
  const subject = ctx.db.prepare("SELECT * FROM subjects WHERE id = ?").get(subjectId) as
    | { id: string; status: string }
    | undefined;
  if (!subject) throw ERR.notFound("subject");
  const nowIso = ctx.clock.now().toISOString();
  withTransaction(ctx.db, () => {
    ctx.db.prepare("INSERT INTO consent_events(id, subject_id, kind, signed_at, recorded_at) VALUES (?,?,?,?,?)").run(
      newId(), subjectId, "withdrawn", nowIso, nowIso);
    ctx.db.prepare("UPDATE subjects SET status = 'withdrawn' WHERE id = ? AND status != 'randomized_in_error'").run(subjectId);
    appendAudit(ctx.db, { entityType: "subject", entityId: subjectId, action: "consent_withdrawn", payload: {}, operatorId: ctx.operatorId }, nowIso);
  });
}

export function consentActiveAt(db: DatabaseSync, subjectId: string, at: Date): boolean {
  const rows = db.prepare("SELECT kind, signed_at FROM consent_events WHERE subject_id = ? ORDER BY signed_at, rowid").all(subjectId) as
    { kind: string; signed_at: string }[];
  let active = false;
  for (const r of rows) {
    if (new Date(r.signed_at).getTime() <= at.getTime()) active = r.kind === "given";
  }
  return active;
}

export function latestEligibility(db: DatabaseSync, subjectId: string): { passed: number; protocol_version_id: string } | undefined {
  return db.prepare(
    "SELECT passed, protocol_version_id FROM eligibility_results WHERE subject_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1",
  ).get(subjectId) as { passed: number; protocol_version_id: string } | undefined;
}
