import { test } from "node:test";
import assert from "node:assert/strict";
import { setup, enrollEligible } from "./helpers.js";
import * as subjectSvc from "../src/services/subject.js";
import * as trialSvc from "../src/services/trial.js";
import * as unblindSvc from "../src/services/unblind.js";

test("blinded roles cannot view arms or unblind", () => {
  const { db, ctx, trialId, siteId } = setup();
  trialSvc.addUser(db, "b-carol", "blinded");
  trialSvc.addUser(db, "u-dana", "unblinded");
  trialSvc.addUser(db, "root", "admin");
  const s = enrollEligible(db, ctx, trialId, siteId);
  subjectSvc.assignSubject(db, ctx, { subjectId: s, actor: "t" });

  assert.throws(() => unblindSvc.assertCanViewArm(db, "b-carol"), /FORBIDDEN|may not view/);
  assert.throws(
    () => unblindSvc.unblindSubject(db, ctx, { subjectId: s, reason: "x", emergency: false, actor: "b-carol" }),
    /may not unblind/
  );
  const r = unblindSvc.unblindSubject(db, ctx, { subjectId: s, reason: "planned", emergency: false, actor: "u-dana" });
  assert.ok(["X", "Y"].includes(r.arm));
});

test("emergency unblinding writes to the dedicated audit chain", () => {
  const { db, ctx, trialId, siteId } = setup();
  trialSvc.addUser(db, "u-dana", "unblinded");
  const s = enrollEligible(db, ctx, trialId, siteId);
  subjectSvc.assignSubject(db, ctx, { subjectId: s, actor: "t" });
  unblindSvc.unblindSubject(db, ctx, { subjectId: s, reason: "SAE", emergency: true, actor: "u-dana" });
  const rows = db.prepare(
    "SELECT * FROM audit_log WHERE chain = 'unblinding' AND action = 'unblind.emergency'"
  ).all();
  assert.equal(rows.length, 1);
  const u = db.prepare("SELECT * FROM unblindings WHERE subject_id = ?").get(s) as any;
  assert.equal(u.emergency, 1);
});
