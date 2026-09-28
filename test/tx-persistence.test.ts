import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { setup, enrollEligible } from "./helpers.js";
import { openDb, tx } from "../src/db.js";
import * as subjectSvc from "../src/services/subject.js";
import { verifyChain } from "../src/audit.js";

test("transaction rolls back fully on failure", () => {
  const { db, ctx, trialId, siteId } = setup();
  const s = enrollEligible(db, ctx, trialId, siteId);
  const before = (db.prepare("SELECT COUNT(*) c FROM random_sequences").get() as any).c;
  assert.throws(() =>
    tx(db, () => {
      // consume a slot, then blow up before commit
      db.prepare(
        "INSERT INTO random_sequences (trial_id, site_id, stratum_key, seq_no, block_no, arm) VALUES (?,?,?,?,?,?)"
      ).run(trialId, siteId, "{}", 999, 99, "X");
      throw new Error("boom");
    })
  );
  const after = (db.prepare("SELECT COUNT(*) c FROM random_sequences").get() as any).c;
  assert.equal(after, before, "no partial writes may survive a rollback");
  // subject untouched
  assert.equal((db.prepare("SELECT status FROM subjects WHERE id = ?").get(s) as any).status, "eligible");
});

test("failed assignment (no consent) leaves no consumed slot", () => {
  const { db, ctx, trialId, siteId } = setup();
  const { id } = subjectSvc.registerSubject(db, ctx, { trialId, siteId, anonCode: "A-F1", stratum: {}, actor: "t" });
  subjectSvc.recordScreening(db, ctx, { subjectId: id, criteria: {}, eligible: true, actor: "t" });
  assert.throws(() => subjectSvc.assignSubject(db, ctx, { subjectId: id, actor: "t" }), /consent/i);
  const consumed = db.prepare("SELECT COUNT(*) c FROM random_sequences WHERE status='consumed'").get() as any;
  assert.equal(consumed.c, 0);
});

test("state persists across process restart (close + reopen)", () => {
  const path = "test-restart.db";
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(path + s); } catch {} }

  let subjId: number;
  {
    const { db, ctx, trialId, siteId } = setup(path);
    subjId = enrollEligible(db, ctx, trialId, siteId);
    subjectSvc.assignSubject(db, ctx, { subjectId: subjId, actor: "t" });
    db.close();
  }
  {
    const db2 = openDb(path); // migrations re-run: must be idempotent
    const s = db2.prepare("SELECT status FROM subjects WHERE id = ?").get(subjId) as any;
    assert.equal(s.status, "assigned");
    const a = db2.prepare("SELECT arm FROM assignments WHERE subject_id = ?").get(subjId) as any;
    assert.ok(["X", "Y"].includes(a.arm));
    assert.ok(verifyChain(db2, "main"));
    // migrations applied exactly once
    const m = db2.prepare("SELECT COUNT(*) c FROM schema_migrations").get() as any;
    assert.equal(m.c, 1);
    db2.close();
  }
  for (const s of ["", "-wal", "-shm"]) { try { rmSync(path + s); } catch {} }
});
