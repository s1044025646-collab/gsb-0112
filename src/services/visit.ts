import type { DB } from "../db.js";
import { err } from "../errors.js";
import { audit } from "../audit.js";
import type { Ctx } from "../context.js";
import { getSubject } from "./subject.js";
import { protocolVersionAt, type VisitWindow } from "./trial.js";

const DAY_MS = 24 * 3600 * 1000;

/** Local calendar date (yyyy-mm-dd) of an instant in the site's timezone. */
export function localDate(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Record a visit and judge the window deviation against the protocol
 * version effective at the visit time. The judgement is stored immutably;
 * later protocol amendments never rewrite history.
 */
export function recordVisit(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; visitName: string; occurredAt: string; actor: string }
): { id: number; inWindow: boolean; protocolVersion: string; windowStart: string; windowEnd: string } {
  const s = getSubject(db, input.subjectId);
  if (s.status !== "assigned") throw err.state("visits require an assigned subject");
  const assignment = db
    .prepare("SELECT * FROM assignments WHERE subject_id = ?")
    .get(input.subjectId) as any;
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(s.site_id) as any;

  const occurred = new Date(input.occurredAt);
  if (isNaN(occurred.getTime())) throw err.validation("occurredAt is not a valid timestamp");

  const pv = protocolVersionAt(db, s.trial_id, occurred);
  const windows = JSON.parse(pv.visit_windows) as VisitWindow[];
  const win = windows.find((w) => w.name === input.visitName);
  if (!win)
    throw err.validation(`visit '${input.visitName}' not defined in protocol ${pv.version}`);

  // Windows are computed on site-local calendar days relative to assignment day.
  const baseLocal = localDate(assignment.assigned_at, site.timezone);
  const startLocal = addDays(baseLocal, win.target_day - win.minus_days);
  const endLocal = addDays(baseLocal, win.target_day + win.plus_days);
  const occurredLocal = localDate(input.occurredAt, site.timezone);
  const inWindow = occurredLocal >= startLocal && occurredLocal <= endLocal;

  const dup = db
    .prepare("SELECT id FROM visits WHERE subject_id = ? AND visit_name = ?")
    .get(input.subjectId, input.visitName);
  if (dup) throw err.conflict(`visit '${input.visitName}' already recorded for subject`);

  const r = db
    .prepare(
      `INSERT INTO visits (subject_id, visit_name, occurred_at, protocol_version, window_start, window_end, in_window, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    .run(
      input.subjectId,
      input.visitName,
      occurred.toISOString(),
      pv.version,
      startLocal,
      endLocal,
      inWindow ? 1 : 0,
      ctx.now().toISOString()
    );
  const id = Number(r.lastInsertRowid);
  if (!inWindow) {
    db.prepare(
      `INSERT INTO deviations (subject_id, type, description, protocol_version, is_deviation, created_at)
       VALUES (?,?,?,?,1,?)`
    ).run(
      input.subjectId,
      "VISIT_WINDOW",
      `visit ${input.visitName} on ${occurredLocal} outside window ${startLocal}..${endLocal}`,
      pv.version,
      ctx.now().toISOString()
    );
  }
  audit(db, { chain: "main", actor: input.actor, action: "visit.record", entity: "visit", entityId: String(id), detail: { visitName: input.visitName, inWindow, protocolVersion: pv.version } }, ctx.now());
  return { id, inWindow, protocolVersion: pv.version, windowStart: startLocal, windowEnd: endLocal };
}

function addDays(localDateStr: string, days: number): string {
  const d = new Date(localDateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Report a deviation judged under the protocol version effective now. */
export function reportDeviation(
  db: DB,
  ctx: Ctx,
  input: { subjectId: number; type: string; description: string; actor: string }
): { id: number; protocolVersion: string } {
  const s = getSubject(db, input.subjectId);
  const pv = protocolVersionAt(db, s.trial_id, ctx.now());
  const r = db
    .prepare(
      `INSERT INTO deviations (subject_id, type, description, protocol_version, is_deviation, created_at)
       VALUES (?,?,?,?,1,?)`
    )
    .run(input.subjectId, input.type, input.description, pv.version, ctx.now().toISOString());
  const id = Number(r.lastInsertRowid);
  audit(db, { chain: "main", actor: input.actor, action: "deviation.report", entity: "deviation", entityId: String(id), detail: { type: input.type, protocolVersion: pv.version } }, ctx.now());
  return { id, protocolVersion: pv.version };
}
