import type { DB } from "../src/db.js";
import type { Ctx } from "../src/context.js";
import * as trialSvc from "../src/services/trial.js";
import * as subjectSvc from "../src/services/subject.js";
import * as visitSvc from "../src/services/visit.js";
import * as unblindSvc from "../src/services/unblind.js";

/**
 * Fully fictional fixture data. No real persons, sites, or products.
 * Covers: stratum imbalance, duplicate enrollment, withdrawal + re-entry,
 * emergency unblinding, visit-window boundaries, protocol amendment.
 */
export function loadFixtures(db: DB, ctx: Ctx, log: (m: string) => void = () => {}) {
  const A = "fixture-admin";

  const { id: trialId } = trialSvc.createTrial(db, ctx, {
    code: "FICTION-001",
    title: "Fictional Study of Placebo vs Placebo",
    arms: ["X", "Y"],
    blockSize: 4,
    actor: A,
  });
  log("trial FICTION-001 id=" + trialId);

  trialSvc.addProtocolVersion(db, ctx, {
    trialId,
    version: "v1.0",
    effectiveFrom: "2026-01-01T00:00:00Z",
    visitWindows: [
      { name: "V1", target_day: 7, minus_days: 2, plus_days: 2 },
      { name: "V2", target_day: 28, minus_days: 3, plus_days: 3 },
    ],
    actor: A,
  });
  // Amendment effective later: tightens V1 window.
  trialSvc.addProtocolVersion(db, ctx, {
    trialId,
    version: "v2.0",
    effectiveFrom: "2026-03-01T00:00:00Z",
    visitWindows: [
      { name: "V1", target_day: 7, minus_days: 1, plus_days: 1 },
      { name: "V2", target_day: 28, minus_days: 3, plus_days: 3 },
    ],
    actor: A,
  });

  const { id: siteSh } = trialSvc.addSite(db, ctx, { trialId, code: "SH", name: "Fictional Shanghai Site", timezone: "Asia/Shanghai", actor: A });
  const { id: siteNy } = trialSvc.addSite(db, ctx, { trialId, code: "NY", name: "Fictional New York Site", timezone: "America/New_York", actor: A });

  trialSvc.addUser(db, "op-bob", "operator");
  trialSvc.addUser(db, "blinded-carol", "blinded");
  trialSvc.addUser(db, "unblinded-dana", "unblinded");

  const enroll = (anon: string, siteId: number, stratum: Record<string, string>, signedAt: string) => {
    const { id } = subjectSvc.registerSubject(db, ctx, { trialId, siteId, anonCode: anon, stratum, actor: A });
    subjectSvc.recordScreening(db, ctx, { subjectId: id, criteria: { inc1: true, exc1: false }, eligible: true, actor: A });
    subjectSvc.recordConsent(db, ctx, { subjectId: id, consentVersion: "ICF-1.0", signedAt, actor: A });
    return id;
  };

  // Stratum imbalance: many subjects in one stratum, few in the other.
  const s1 = enroll("ANON-001", siteSh, { age: "lt65", sex: "F" }, "2026-01-04T01:00:00Z");
  const s2 = enroll("ANON-002", siteSh, { age: "lt65", sex: "F" }, "2026-01-04T01:00:00Z");
  const s3 = enroll("ANON-003", siteSh, { age: "lt65", sex: "M" }, "2026-01-04T01:00:00Z");
  const s4 = enroll("ANON-004", siteNy, { age: "gte65", sex: "F" }, "2026-01-04T01:00:00Z");
  const s5 = enroll("ANON-005", siteNy, { age: "gte65", sex: "M" }, "2026-01-04T01:00:00Z");

  for (const id of [s1, s2, s3, s4, s5]) {
    const r = subjectSvc.assignSubject(db, ctx, { subjectId: id, actor: A });
    log("subject " + id + " assigned seq=" + r.seqNo);
  }

  // Duplicate enrollment attempt (same anon code) -> conflict, caught here.
  try {
    subjectSvc.registerSubject(db, ctx, { trialId, siteId: siteSh, anonCode: "ANON-001", stratum: { age: "lt65" }, actor: A });
  } catch (e: any) {
    log("duplicate enrollment rejected: " + e.code);
  }

  // Withdrawal then re-entry as a NEW anonymous record.
  subjectSvc.withdrawSubject(db, ctx, { subjectId: s2, reason: "withdrew consent (fictional)", actor: A });
  log("subject " + s2 + " withdrawn");
  const s2b = enroll("ANON-002R", siteSh, { age: "lt65", sex: "F" }, "2026-01-04T01:00:00Z");
  const r2b = subjectSvc.assignSubject(db, ctx, { subjectId: s2b, actor: A });
  log("re-entry subject " + s2b + " assigned seq=" + r2b.seqNo + " (old number not recycled)");

  // Mis-randomization report (fictional).
  subjectSvc.reportMisrandomization(db, ctx, { subjectId: s3, detail: "kit mix-up at site (fictional)", actor: A });

  // Emergency unblinding by an authorized unblinded user.
  const ub = unblindSvc.unblindSubject(db, ctx, { subjectId: s4, reason: "fictional SAE", emergency: true, actor: "unblinded-dana" });
  log("subject " + s4 + " emergency-unblinded (arm=" + ub.arm + ")");

  // Visit boundary cases under v1.0 (before amendment).
  const a1 = db.prepare("SELECT assigned_at FROM assignments WHERE subject_id = ?").get(s1) as any;
  const base = new Date(a1.assigned_at);
  const atDay = (d: number) => new Date(base.getTime() + d * 86400000).toISOString();
  const v1 = visitSvc.recordVisit(db, ctx, { subjectId: s1, visitName: "V1", occurredAt: atDay(5), actor: A }); // day 5 = 7-2, edge
  log("s1 V1 inWindow=" + v1.inWindow + " (protocol " + v1.protocolVersion + ")");
  const v2 = visitSvc.recordVisit(db, ctx, { subjectId: s1, visitName: "V2", occurredAt: atDay(40), actor: A }); // way out
  log("s1 V2 inWindow=" + v2.inWindow + " -> deviation auto-recorded");

  // A visit judged after the amendment uses v2.0 rules.
  const lateVisit = visitSvc.recordVisit(db, ctx, {
    subjectId: s3,
    visitName: "V1",
    occurredAt: "2026-03-10T01:00:00Z",
    actor: A,
  });
  log("s3 V1 judged under " + lateVisit.protocolVersion + " inWindow=" + lateVisit.inWindow);

  visitSvc.reportDeviation(db, ctx, { subjectId: s5, type: "IP_COMPLIANCE", description: "fictional missed dose", actor: A });

  return { trialId, siteSh, siteNy, subjects: { s1, s2, s2b, s3, s4, s5 } };
}
