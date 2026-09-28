import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, enrollEligible } from "./helpers.js";
import * as subjectSvc from "../src/services/subject.js";
import * as trialSvc from "../src/services/trial.js";
import * as visitSvc from "../src/services/visit.js";

test("visit window judged by protocol version effective at visit time; history immutable", () => {
  const { db, ctx, trialId, siteId } = setup();
  const s = enrollEligible(db, ctx, trialId, siteId);
  subjectSvc.assignSubject(db, ctx, { subjectId: s, actor: "t" }); // assigned 2026-01-05

  // V1 target day 7 ±2 under v1.0 -> window days 5..9 (site-local)
  const inW = visitSvc.recordVisit(db, ctx, { subjectId: s, visitName: "V1", occurredAt: "2026-01-10T01:00:00Z", actor: "t" });
  assert.equal(inW.inWindow, true);
  assert.equal(inW.protocolVersion, "v1.0");

  // Amendment tightens window to ±1 from 2026-02-01
  trialSvc.addProtocolVersion(db, ctx, {
    trialId, version: "v2.0", effectiveFrom: "2026-02-01T00:00:00Z",
    visitWindows: [{ name: "V2", target_day: 28, minus_days: 1, plus_days: 1 }],
    actor: "t",
  });
  // day 26 after assignment: outside ±1 under v2.0
  const out = visitSvc.recordVisit(db, ctx, { subjectId: s, visitName: "V2", occurredAt: "2026-02-10T01:00:00Z", actor: "t" });
  assert.equal(out.inWindow, false);
  assert.equal(out.protocolVersion, "v2.0");

  // Historical judgement must not be rewritten by the amendment.
  const old = db.prepare("SELECT * FROM visits WHERE visit_name = 'V1'").get() as any;
  assert.equal(old.in_window, 1);
  assert.equal(old.protocol_version, "v1.0");

  // Out-of-window visit auto-creates a deviation.
  const dev = db.prepare("SELECT * FROM deviations WHERE subject_id = ? AND type = 'VISIT_WINDOW'").get(s) as any;
  assert.ok(dev);
  assert.equal(dev.protocol_version, "v2.0");
});

test("visit windows respect site timezone (cross-timezone boundary)", () => {
  const { db, ctx, trialId, A } = setup();
  const { id: siteNy } = trialSvc.addSite(db, ctx, {
    trialId, code: "NY", name: "NY", timezone: "America/New_York", actor: A,
  });
  const s = enrollEligible(db, ctx, trialId, siteNy);
  // assign at 2026-01-05T02:00:00Z -> still Jan 4 local in New York
  ctxNowPatch: {
    // assignment uses ctx clock (2026-01-05T01:00Z) => local Jan 4 20:00 EST
  }
  subjectSvc.assignSubject(db, ctx, { subjectId: s, actor: "t" });
  const v = visitSvc.recordVisit(db, ctx, { subjectId: s, visitName: "V1", occurredAt: "2026-01-12T04:30:00Z", actor: "t" });
  // occurred Jan 11 23:30 EST local; base local Jan 4; day diff = 7 -> in window
  assert.equal(v.inWindow, true);
});

test("duplicate visit recording is rejected", () => {
  const { db, ctx, trialId, siteId } = setup();
  const s = enrollEligible(db, ctx, trialId, siteId);
  subjectSvc.assignSubject(db, ctx, { subjectId: s, actor: "t" });
  visitSvc.recordVisit(db, ctx, { subjectId: s, visitName: "V1", occurredAt: "2026-01-12T01:00:00Z", actor: "t" });
  assert.throws(
    () => visitSvc.recordVisit(db, ctx, { subjectId: s, visitName: "V1", occurredAt: "2026-01-12T02:00:00Z", actor: "t" }),
    /already recorded/
  );
});
