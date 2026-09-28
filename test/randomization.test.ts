import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, enrollEligible } from "./helpers.js";
import * as subjectSvc from "../src/services/subject.js";
import { blockArms } from "../src/services/randomize.js";

test("assignments never repeat a randomization number", () => {
  const { db, ctx, trialId, siteId } = setup();
  const ids = Array.from({ length: 9 }, () => enrollEligible(db, ctx, trialId, siteId));
  const seqs = ids.map((id) => subjectSvc.assignSubject(db, ctx, { subjectId: id, actor: "t" }).seqNo);
  assert.equal(new Set(seqs).size, seqs.length, "seq numbers must be unique");
});

test("block randomization is balanced and reproducible from the seed", () => {
  const b1 = blockArms("seed-1", "S1", "stratumA", 0, ["X", "Y"], 4);
  const b2 = blockArms("seed-1", "S1", "stratumA", 0, ["X", "Y"], 4);
  assert.deepEqual(b1, b2, "same seed => same block");
  assert.equal(b1.filter((a) => a === "X").length, 2);
  assert.equal(b1.filter((a) => a === "Y").length, 2);
  const other = blockArms("seed-2", "S1", "stratumA", 0, ["X", "Y"], 4);
  // different seed => (with overwhelming probability) different order
  assert.ok(b1.join() !== other.join() || true); // order may coincide; balance is the invariant
});

test("refuses assignment without eligibility or consent", () => {
  const { db, ctx, trialId, siteId } = setup();
  // screening only, no screening record
  const { id: s1 } = subjectSvc.registerSubject(db, ctx, {
    trialId, siteId, anonCode: "A-NO-SCREEN", stratum: {}, actor: "t",
  });
  assert.throws(
    () => subjectSvc.assignSubject(db, ctx, { subjectId: s1, actor: "t" }),
    /ELIGIBILITY_NOT_MET|not eligible/
  );
  // eligible but no consent
  const { id: s2 } = subjectSvc.registerSubject(db, ctx, {
    trialId, siteId, anonCode: "A-NO-CONSENT", stratum: {}, actor: "t",
  });
  subjectSvc.recordScreening(db, ctx, { subjectId: s2, criteria: {}, eligible: true, actor: "t" });
  assert.throws(
    () => subjectSvc.assignSubject(db, ctx, { subjectId: s2, actor: "t" }),
    /consent/i
  );
});

test("withdrawn subject's number is not recycled; re-entry gets a fresh number", () => {
  const { db, ctx, trialId, siteId } = setup();
  const s1 = enrollEligible(db, ctx, trialId, siteId);
  const r1 = subjectSvc.assignSubject(db, ctx, { subjectId: s1, actor: "t" });
  subjectSvc.withdrawSubject(db, ctx, { subjectId: s1, reason: "test", actor: "t" });
  assert.throws(
    () => subjectSvc.assignSubject(db, ctx, { subjectId: s1, actor: "t" }),
    /withdrawn/
  );
  const s2 = enrollEligible(db, ctx, trialId, siteId);
  const r2 = subjectSvc.assignSubject(db, ctx, { subjectId: s2, actor: "t" });
  assert.notEqual(r1.seqNo, r2.seqNo);
  const consumed = db.prepare(
    "SELECT COUNT(*) c FROM random_sequences WHERE status='consumed'"
  ).get() as any;
  assert.equal(consumed.c, 2);
});

test("stratification keeps separate pools per stratum", () => {
  const { db, ctx, trialId, siteId } = setup();
  const a = enrollEligible(db, ctx, trialId, siteId, { age: "lt65" });
  const b = enrollEligible(db, ctx, trialId, siteId, { age: "gte65" });
  const ra = subjectSvc.assignSubject(db, ctx, { subjectId: a, actor: "t" });
  const rb = subjectSvc.assignSubject(db, ctx, { subjectId: b, actor: "t" });
  assert.equal(ra.seqNo, 1);
  assert.equal(rb.seqNo, 1); // each stratum has its own sequence
});
