import { newId } from "../domain/ids.ts";
import { ERR } from "../domain/errors.ts";
import { appendAudit } from "../domain/audit.ts";
import { withTransaction } from "../db/database.ts";
import type { TrialContext } from "./trial-service.ts";
import { versionEffectiveAt } from "./trial-service.ts";

export interface WindowSpec {
  visitCode: string;
  offsetDays: number;
  windowLowDays: number;
  windowHighDays: number;
}

export function addVisitWindow(ctx: TrialContext, protocolVersionId: string, spec: WindowSpec): void {
  if (!/^[A-Z0-9_]{1,20}$/.test(spec.visitCode)) throw ERR.validation("visit code must be [A-Z0-9_]");
  if (!Number.isInteger(spec.offsetDays)) throw ERR.validation("offsetDays must be an integer number of days");
  if (spec.windowLowDays < 0 || spec.windowHighDays < spec.windowLowDays) {
    throw ERR.validation("window bounds invalid: require 0 <= low <= high");
  }
  withTransaction(ctx.db, () => {
    const exists = ctx.db.prepare("SELECT id FROM visit_windows WHERE protocol_version_id = ? AND visit_code = ?").get(protocolVersionId, spec.visitCode);
    if (exists) throw ERR.conflict("VISIT_WINDOW_EXISTS", "use a new protocol version to change visit windows");
    ctx.db.prepare(
      "INSERT INTO visit_windows(id, protocol_version_id, visit_code, offset_days, window_low_days, window_high_days) VALUES (?,?,?,?,?,?)",
    ).run(newId(), protocolVersionId, spec.visitCode, spec.offsetDays, spec.windowLowDays, spec.windowHighDays);
  });
}

function dayStartInZone(date: Date, timeZone: string): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const map = new Map(fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const dayStr = `${map.get("year")}-${map.get("month")}-${map.get("day")}`;
  return new Date(`${dayStr}T00:00:00Z`);
}

const DAY_MS = 86_400_000;

export function scheduleVisit(ctx: TrialContext, subjectId: string, visitCode: string, baselineAt: Date) {
  const subject = ctx.db.prepare(
    `SELECT s.trial_id, si.timezone AS site_tz FROM subjects s JOIN sites si ON si.id = s.site_id WHERE s.id = ?`,
  ).get(subjectId) as { trial_id: string; site_tz: string } | undefined;
  if (!subject) throw ERR.notFound("subject");
  const version = versionEffectiveAt(ctx, subject.trial_id, baselineAt) as { id: string };
  const winRow = ctx.db.prepare(
    "SELECT offset_days AS offsetDays, window_low_days AS windowLowDays, window_high_days AS windowHighDays FROM visit_windows WHERE protocol_version_id = ? AND visit_code = ?",
  ).get(version.id, visitCode) as Omit<WindowSpec, "visitCode"> | undefined;
  const win = winRow ? { visitCode, ...winRow } : undefined;
  if (!win) throw ERR.notFound(`visit window ${visitCode} for protocol effective at baseline`);

  const baseDay = dayStartInZone(baselineAt, subject.site_tz);
  const from = new Date(baseDay.getTime() + (win.offsetDays - win.windowLowDays) * DAY_MS);
  const to = new Date(baseDay.getTime() + (win.offsetDays + win.windowHighDays) * DAY_MS + DAY_MS - 1000);
  const nowIso = ctx.clock.now().toISOString();
  return withTransaction(ctx.db, () => {
    const exists = ctx.db.prepare("SELECT id FROM visit_records WHERE subject_id = ? AND visit_code = ?").get(subjectId, visitCode);
    if (exists) throw ERR.conflict("VISIT_ALREADY_SCHEDULED", `${visitCode} already scheduled`);
    const id = newId();
    ctx.db.prepare(
      `INSERT INTO visit_records(id, subject_id, visit_code, scheduled_from, scheduled_to, occurred_at,
       protocol_version_at_schedule, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, subjectId, visitCode, from.toISOString(), to.toISOString(), null, version.id, "scheduled", nowIso);
    appendAudit(ctx.db, { entityType: "visit", entityId: id, action: "scheduled", payload: { subjectId, visitCode, version: version.id }, operatorId: ctx.operatorId }, nowIso);
    return { id, from: from.toISOString(), to: to.toISOString(), protocolVersionId: version.id };
  });
}

export interface DeviationResult {
  deviationId: string | null;
  withinWindow: boolean;
  kind: string | null;
  judgedFromVersion: string;
}

export function recordVisit(ctx: TrialContext, subjectId: string, visitCode: string, occurredAt: Date): DeviationResult {
  const record = ctx.db.prepare("SELECT * FROM visit_records WHERE subject_id = ? AND visit_code = ?").get(subjectId, visitCode) as
    | { id: string; scheduled_from: string; scheduled_to: string; protocol_version_at_schedule: string; status: string }
    | undefined;
  if (!record) throw ERR.notFound(`scheduled visit ${visitCode}`);
  if (record.status === "done") throw ERR.conflict("VISIT_ALREADY_DONE", "visit already recorded");

  const subject = ctx.db.prepare("SELECT trial_id FROM subjects WHERE id = ?").get(subjectId) as { trial_id: string };
  const effectiveVersion = versionEffectiveAt(ctx, subject.trial_id, occurredAt) as { id: string };
  const within = occurredAt.getTime() >= new Date(record.scheduled_from).getTime()
    && occurredAt.getTime() <= new Date(record.scheduled_to).getTime();

  let kind: string | null = null;
  if (!within) {
    kind = occurredAt.getTime() < new Date(record.scheduled_from).getTime()
      ? "visit_out_of_window_early"
      : "visit_out_of_window_late";
  } else if (effectiveVersion.id !== record.protocol_version_at_schedule) {
    kind = "visit_under_new_protocol_version";
  }

  const nowIso = ctx.clock.now().toISOString();
  return withTransaction(ctx.db, () => {
    let deviationId: string | null = null;
    if (kind) {
      deviationId = newId();
      ctx.db.prepare(
        `INSERT INTO deviations(id, subject_id, visit_code, protocol_version_id, kind, detail, event_at, detected_at, superseded)
         VALUES (?,?,?,?,?,?,?,?,0)`,
      ).run(deviationId, subjectId, visitCode, effectiveVersion.id, kind,
        `scheduled under ${record!.protocol_version_at_schedule}; event judged under ${effectiveVersion.id}; window ${record!.scheduled_from}..${record!.scheduled_to}`,
        occurredAt.toISOString(), nowIso);
    }
    ctx.db.prepare("UPDATE visit_records SET status='done', occurred_at=? WHERE id=?").run(occurredAt.toISOString(), record!.id);
    appendAudit(ctx.db, {
      entityType: "visit", entityId: record!.id, action: "recorded",
      payload: { subjectId, visitCode, occurredAt: occurredAt.toISOString(), withinWindow: within, deviationId },
      operatorId: ctx.operatorId,
    }, nowIso);
    return { deviationId, withinWindow: within, kind, judgedFromVersion: effectiveVersion.id };
  });
}

export function reportManualDeviation(ctx: TrialContext, subjectId: string, kind: string, detail: string, eventAt: Date): string {
  const subject = ctx.db.prepare("SELECT trial_id FROM subjects WHERE id = ?").get(subjectId) as { trial_id: string } | undefined;
  if (!subject) throw ERR.notFound("subject");
  if (!/^[a-z0-9_]{3,40}$/.test(kind)) throw ERR.validation("deviation kind must be [a-z0-9_], 3-40 chars");
  if (!detail || detail.length > 500) throw ERR.validation("detail required (max 500 chars)");
  const version = versionEffectiveAt(ctx, subject.trial_id, eventAt) as { id: string };
  const nowIso = ctx.clock.now().toISOString();
  return withTransaction(ctx.db, () => {
    const id = newId();
    ctx.db.prepare(
      `INSERT INTO deviations(id, subject_id, visit_code, protocol_version_id, kind, detail, event_at, detected_at, superseded)
       VALUES (?,?,NULL,?,?,?,?,?,0)`,
    ).run(id, subjectId, version.id, kind, detail, eventAt.toISOString(), nowIso);
    appendAudit(ctx.db, { entityType: "deviation", entityId: id, action: "reported_manual", payload: { subjectId, kind, version: version.id }, operatorId: ctx.operatorId }, nowIso);
    return id;
  });
}

export function listDeviations(db: import("node:sqlite").DatabaseSync, opts: { trialId?: string; limit: number; offset: number }) {
  const where = opts.trialId ? "WHERE s.trial_id = ?" : "";
  const params: string[] = opts.trialId ? [opts.trialId] : [];
  const rows = db.prepare(
    `SELECT d.* FROM deviations d JOIN subjects s ON s.id = d.subject_id ${where}
     ORDER BY d.event_at DESC, d.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, opts.limit, opts.offset);
  const total = (db.prepare(
    `SELECT COUNT(*) AS c FROM deviations d JOIN subjects s ON s.id = d.subject_id ${where}`,
  ).all(...params)[0] as { c: number }).c;
  return { rows, total };
}
