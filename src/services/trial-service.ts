import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { randomBytes } from "node:crypto";
import { ERR } from "../domain/errors.ts";
import { appendAudit } from "../domain/audit.ts";
import { withTransaction } from "../db/database.ts";

export interface ClockProvider {
  now(): Date;
}

export interface TrialContext {
  db: DatabaseSync;
  clock: ClockProvider;
  operatorId?: string;
}

export interface CreateTrialInput {
  code: string;
  name: string;
  blockSize: number;
  version?: string;
}

export function createTrial(ctx: TrialContext, input: CreateTrialInput) {
  if (!/^[A-Z0-9_-]{2,20}$/.test(input.code)) throw ERR.validation("trial code must be 2-20 chars [A-Z0-9_-]");
  if (input.blockSize < 2 || input.blockSize % 2 !== 0) throw ERR.validation("block size must be a positive even number");
  const nowIso = ctx.clock.now().toISOString();
  return withTransaction(ctx.db, () => {
    const trialId = newId();
    const versionId = newId();
    ctx.db.prepare("INSERT INTO trials(id, code, name, rand_secret, current_protocol_version_id, created_at) VALUES (?,?,?,?,?,?)").run(
      trialId, input.code, input.name, randomBytes(32).toString("hex"), versionId, nowIso);
    ctx.db.prepare(
      "INSERT INTO protocol_versions(id, trial_id, version, effective_at, block_size, created_at) VALUES (?,?,?,?,?,?)",
    ).run(versionId, trialId, input.version ?? "v1.0", nowIso, input.blockSize, nowIso);
    appendAudit(ctx.db, { entityType: "trial", entityId: trialId, action: "created", payload: { code: input.code }, operatorId: ctx.operatorId }, nowIso);
    return getTrial(ctx, trialId);
  });
}

export function getTrial(ctx: TrialContext, id: string) {
  const row = ctx.db.prepare(
    `SELECT t.*, pv.version AS protocol_version, pv.block_size
     FROM trials t JOIN protocol_versions pv ON pv.id = t.current_protocol_version_id
     WHERE t.id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  if (!row) throw ERR.notFound("trial");
  return row;
}

export function getTrialByCode(ctx: TrialContext, code: string) {
  const row = ctx.db.prepare("SELECT id FROM trials WHERE code = ?").get(code) as { id: string } | undefined;
  if (!row) throw ERR.notFound(`trial ${code}`);
  return getTrial(ctx, row.id);
}

export function addProtocolVersion(ctx: TrialContext, trialId: string, version: string, blockSize: number, effectiveAt: Date) {
  const trial = ctx.db.prepare("SELECT id FROM trials WHERE id = ?").get(trialId);
  if (!trial) throw ERR.notFound("trial");
  if (blockSize < 2 || blockSize % 2 !== 0) throw ERR.validation("block size must be a positive even number");
  const nowIso = ctx.clock.now().toISOString();
  return withTransaction(ctx.db, () => {
    const versionId = newId();
    ctx.db.prepare(
      "INSERT INTO protocol_versions(id, trial_id, version, effective_at, block_size, created_at) VALUES (?,?,?,?,?,?)",
    ).run(versionId, trialId, version, effectiveAt.toISOString(), blockSize, nowIso);
    ctx.db.prepare("UPDATE trials SET current_protocol_version_id = ? WHERE id = ?").run(versionId, trialId);
    appendAudit(ctx.db, { entityType: "protocol_version", entityId: versionId, action: "activated", payload: { trialId, version, effectiveAt: effectiveAt.toISOString() }, operatorId: ctx.operatorId }, nowIso);
    return versionAt(ctx, versionId);
  });
}

export function versionAt(ctx: TrialContext, versionId: string) {
  const row = ctx.db.prepare("SELECT * FROM protocol_versions WHERE id = ?").get(versionId);
  if (!row) throw ERR.notFound("protocol version");
  return row;
}

export function versionEffectiveAt(ctx: TrialContext, trialId: string, at: Date) {
  const row = ctx.db.prepare(
    `SELECT * FROM protocol_versions WHERE trial_id = ? AND effective_at <= ?
     ORDER BY effective_at DESC, created_at DESC LIMIT 1`,
  ).get(trialId, at.toISOString()) as Record<string, unknown> | undefined;
  if (!row) throw ERR.conflict("NO_PROTOCOL_VERSION", "no protocol version effective at that time");
  return row;
}

export function addSite(ctx: TrialContext, trialId: string, code: string, name: string, timezone: string) {
  if (!/^[A-Z0-9]{2,10}$/.test(code)) throw ERR.validation("site code must be 2-10 chars [A-Z0-9]");
  validateTimezone(timezone);
  const nowIso = ctx.clock.now().toISOString();
  try {
    const id = newId();
    ctx.db.prepare("INSERT INTO sites(id, trial_id, code, name, timezone, created_at) VALUES (?,?,?,?,?,?)").run(
      id, trialId, code, name, timezone, nowIso);
    appendAudit(ctx.db, { entityType: "site", entityId: id, action: "created", payload: { code, name, timezone }, operatorId: ctx.operatorId }, nowIso);
    return ctx.db.prepare("SELECT * FROM sites WHERE id = ?").get(id);
  } catch (e) {
    if ((e as Error).message.includes("UNIQUE")) throw ERR.conflict("SITE_CODE_EXISTS", `site ${code} already exists`);
    throw e;
  }
}

export function addStratum(ctx: TrialContext, trialId: string, factorKey: string, factorValue: string) {
  if (!/^[a-z0-9_]{1,30}$/.test(factorKey)) throw ERR.validation("factor key must be [a-z0-9_]");
  if (!factorValue || factorValue.length > 40) throw ERR.validation("factor value required (max 40 chars)");
  const nowIso = ctx.clock.now().toISOString();
  try {
    const id = newId();
    ctx.db.prepare("INSERT INTO strata(id, trial_id, factor_key, factor_value, created_at) VALUES (?,?,?,?,?)").run(
      id, trialId, factorKey, factorValue, nowIso);
    appendAudit(ctx.db, { entityType: "stratum", entityId: id, action: "created", payload: { factorKey, factorValue }, operatorId: ctx.operatorId }, nowIso);
    return id;
  } catch (e) {
    if ((e as Error).message.includes("UNIQUE")) throw ERR.conflict("STRATUM_EXISTS", `${factorKey}=${factorValue} already exists`);
    throw e;
  }
}

function validateTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw ERR.validation(`invalid IANA timezone: ${tz}`);
  }
}
