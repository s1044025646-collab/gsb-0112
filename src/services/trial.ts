import type { DB } from "../db.js";
import { err } from "../errors.js";
import { audit } from "../audit.js";
import type { Ctx } from "../context.js";

export interface VisitWindow {
  name: string;
  target_day: number;
  minus_days: number;
  plus_days: number;
}

export function createTrial(
  db: DB,
  ctx: Ctx,
  input: {
    code: string;
    title: string;
    arms: string[];
    blockSize: number;
    actor: string;
  }
): { id: number } {
  if (!input.arms.length) throw err.validation("arms must be non-empty");
  if (input.blockSize < input.arms.length)
    throw err.validation("blockSize must be >= number of arms");
  const seed = ctx.randomBytes(32).toString("hex");
  const now = ctx.now().toISOString();
  const r = db
    .prepare(
      "INSERT INTO trials (code, title, arms, block_size, seed, created_at) VALUES (?,?,?,?,?,?)"
    )
    .run(input.code, input.title, JSON.stringify(input.arms), input.blockSize, seed, now);
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "trial.create", entity: "trial", entityId: String(id), detail: { code: input.code } }, ctx.now());
  return { id };
}

export function addProtocolVersion(
  db: DB,
  ctx: Ctx,
  input: {
    trialId: number;
    version: string;
    effectiveFrom: string; // ISO
    visitWindows: VisitWindow[];
    actor: string;
  }
): { id: number } {
  getTrial(db, input.trialId);
  const r = db
    .prepare(
      `INSERT INTO protocol_versions (trial_id, version, effective_from, visit_windows, created_at)
       VALUES (?,?,?,?,?)`
    )
    .run(
      input.trialId,
      input.version,
      input.effectiveFrom,
      JSON.stringify(input.visitWindows),
      ctx.now().toISOString()
    );
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "protocol.version.add", entity: "protocol_version", entityId: String(id), detail: { trialId: input.trialId, version: input.version, effectiveFrom: input.effectiveFrom } }, ctx.now());
  return { id };
}

export function addSite(
  db: DB,
  ctx: Ctx,
  input: { trialId: number; code: string; name: string; timezone: string; actor: string }
): { id: number } {
  getTrial(db, input.trialId);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    throw err.validation(`unknown timezone: ${input.timezone}`);
  }
  const r = db
    .prepare("INSERT INTO sites (trial_id, code, name, timezone) VALUES (?,?,?,?)")
    .run(input.trialId, input.code, input.name, input.timezone);
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "site.add", entity: "site", entityId: String(id), detail: { code: input.code } }, ctx.now());
  return { id };
}

export function addUser(db: DB, name: string, role: string): { id: number } {
  const r = db.prepare("INSERT INTO users (name, role) VALUES (?,?)").run(name, role);
  return { id: Number(r.lastInsertRowid) };
}

export function getTrial(db: DB, id: number): any {
  const t = db.prepare("SELECT * FROM trials WHERE id = ?").get(id);
  if (!t) throw err.notFound(`trial ${id} not found`);
  return t;
}

/** Protocol version effective at a given instant (for deviation judgement). */
export function protocolVersionAt(db: DB, trialId: number, at: Date): any {
  const v = db
    .prepare(
      `SELECT * FROM protocol_versions
       WHERE trial_id = ? AND effective_from <= ?
       ORDER BY effective_from DESC LIMIT 1`
    )
    .get(trialId, at.toISOString());
  if (!v) throw err.notFound(`no protocol version effective at ${at.toISOString()}`);
  return v;
}
