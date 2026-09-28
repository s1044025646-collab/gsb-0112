import { openDb, type DB } from "../src/db.js";
import { mutableClock } from "../src/context.js";
import * as trialSvc from "../src/services/trial.js";
import * as subjectSvc from "../src/services/subject.js";

export function setup(dbPath = ":memory:") {
  const clock = mutableClock("2026-01-05T01:00:00Z");
  const db = openDb(dbPath);
  const ctx = clock.ctx;
  const A = "test-admin";
  const { id: trialId } = trialSvc.createTrial(db, ctx, {
    code: "T-1", title: "Test", arms: ["X", "Y"], blockSize: 4, actor: A,
  });
  trialSvc.addProtocolVersion(db, ctx, {
    trialId, version: "v1.0", effectiveFrom: "2026-01-01T00:00:00Z",
    visitWindows: [{ name: "V1", target_day: 7, minus_days: 2, plus_days: 2 }],
    actor: A,
  });
  const { id: siteId } = trialSvc.addSite(db, ctx, {
    trialId, code: "S1", name: "Site", timezone: "Asia/Shanghai", actor: A,
  });
  return { db, ctx, clock, trialId, siteId, A };
}

let counter = 0;
export function enrollEligible(
  db: DB, ctx: any, trialId: number, siteId: number,
  stratum: Record<string, string> = { age: "lt65" }
): number {
  const anon = `ANON-T-${++counter}`;
  const { id } = subjectSvc.registerSubject(db, ctx, { trialId, siteId, anonCode: anon, stratum, actor: "t" });
  subjectSvc.recordScreening(db, ctx, { subjectId: id, criteria: {}, eligible: true, actor: "t" });
  subjectSvc.recordConsent(db, ctx, { subjectId: id, consentVersion: "ICF-1", actor: "t" });
  return id;
}
