import type { DatabaseSync } from "node:sqlite";
import { newId } from "../domain/ids.ts";
import { ERR } from "../domain/errors.ts";
import { appendAudit } from "../domain/audit.ts";
import { withTransaction } from "../db/database.ts";
import { SeededRng, shuffled } from "../domain/rng.ts";
import type { TrialContext } from "./trial-service.ts";
import { consentActiveAt, latestEligibility } from "./subject-service.ts";

export const ARMS = ["A", "B"] as const;
export type Arm = (typeof ARMS)[number];

export interface AllocationView {
  allocationId: string;
  subjectId: string;
  anonCode: string;
  arm?: Arm;
  status: string;
  allocatedAt: string;
}

export function allocate(ctx: TrialContext, subjectId: string): Omit<AllocationView, "anonCode"> {
  const subject = ctx.db.prepare("SELECT * FROM subjects WHERE id = ?").get(subjectId) as
    | { id: string; trial_id: string; site_id: string; status: string; stratum_signature: string | null }
    | undefined;
  if (!subject) throw ERR.notFound("subject");
  if (subject.status !== "screened") {
    throw ERR.conflict("SUBJECT_NOT_ALLOCATABLE", `subject status '${subject.status}' cannot be allocated`);
  }
  const eligibility = latestEligibility(ctx.db, subjectId);
  if (!eligibility || Number(eligibility.passed) !== 1) {
    throw ERR.forbidden("eligibility criteria not met; allocation refused");
  }
  if (!consentActiveAt(ctx.db, subjectId, ctx.clock.now())) {
    throw ERR.forbidden("informed consent not active; allocation refused");
  }
  const trial = ctx.db.prepare("SELECT * FROM trials WHERE id = ?").get(subject.trial_id) as
    | { rand_secret: string }
    | undefined;
  if (!trial) throw ERR.notFound("trial");

  return withTransaction(ctx.db, () => {
    const existing = ctx.db.prepare("SELECT id FROM allocations WHERE subject_id = ?").get(subjectId);
    if (existing) throw ERR.conflict("ALREADY_ALLOCATED", "subject already has an allocation");

    const currentVersion = ctx.db.prepare(
      "SELECT * FROM protocol_versions WHERE id = (SELECT current_protocol_version_id FROM trials WHERE id = ?)",
    ).get(subject.trial_id) as { id: string; block_size: number };
    const signature = subject.stratum_signature!;
    const nextIndex = nextSequenceIndex(ctx.db, subject.trial_id, subject.site_id, signature);
    const blockIndex = Math.floor(nextIndex / currentVersion.block_size);
    const arm = armAtPosition(trial!.rand_secret, subject.site_id, signature, currentVersion.block_size, nextIndex);
    const nowIso = ctx.clock.now().toISOString();
    const allocationId = newId();
    ctx.db.prepare(
      `INSERT INTO allocations(id, subject_id, trial_id, site_id, protocol_version_id, stratum_signature,
       sequence_index, block_index, arm, allocated_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(allocationId, subjectId, subject.trial_id, subject.site_id, currentVersion.id, signature,
      nextIndex, blockIndex, arm, nowIso, "active");
    ctx.db.prepare("UPDATE subjects SET status = 'enrolled' WHERE id = ?").run(subjectId);
    appendAudit(ctx.db, {
      entityType: "allocation", entityId: allocationId, action: "allocated",
      payload: { subjectId, sequenceIndex: nextIndex, blockIndex, arm, stratumSignature: signature },
      operatorId: ctx.operatorId,
    }, nowIso);
    return { allocationId, subjectId, arm, status: "active", allocatedAt: nowIso };
  });
}

function nextSequenceIndex(db: DatabaseSync, trialId: string, siteId: string, signature: string): number {
  const row = db.prepare(
    `SELECT COALESCE(MAX(sequence_index), -1) AS maxIndex FROM allocations
     WHERE trial_id = ? AND site_id = ? AND stratum_signature = ?`,
  ).get(trialId, siteId, signature) as { maxIndex: number };
  return row.maxIndex + 1;
}

export function armAtPosition(
  secret: string,
  siteId: string,
  signature: string,
  blockSize: number,
  index: number,
): Arm {
  const blockIndex = Math.floor(index / blockSize);
  const rng = new SeededRng(`${secret}|${siteId}|${signature}|${blockIndex}|${blockSize}`);
  const block = shuffled(buildBalancedBlock(blockSize), rng);
  return block[index % blockSize]!;
}

function buildBalancedBlock(blockSize: number): Arm[] {
  const arms = ARMS.slice();
  const repeats = blockSize / arms.length;
  return arms.flatMap((arm) => Array.from({ length: repeats }, () => arm));
}

export function markRandomizedInError(ctx: TrialContext, subjectId: string, justification: string): void {
  const subject = ctx.db.prepare("SELECT id, status FROM subjects WHERE id = ?").get(subjectId) as
    | { id: string; status: string }
    | undefined;
  if (!subject) throw ERR.notFound("subject");
  if (subject.status !== "enrolled") throw ERR.conflict("SUBJECT_NOT_ENROLLED", "only enrolled subjects can be marked randomized-in-error");
  const nowIso = ctx.clock.now().toISOString();
  withTransaction(ctx.db, () => {
    ctx.db.prepare("UPDATE subjects SET status = 'randomized_in_error' WHERE id = ?").run(subjectId);
    ctx.db.prepare("UPDATE allocations SET status = 'consumed_in_error' WHERE subject_id = ?").run(subjectId);
    appendAudit(ctx.db, {
      entityType: "subject", entityId: subjectId, action: "randomized_in_error",
      payload: { justification }, operatorId: ctx.operatorId,
    }, nowIso);
  });
}

export function unblind(ctx: TrialContext, subjectId: string, justification: string, reason: "emergency" | "authorized_export", operatorRole: string): AllocationView {
  if (operatorRole !== "unblinded_admin") {
    throw ERR.forbidden("only unblinded_admin may reveal treatment arm");
  }
  const rows = ctx.db.prepare(
    `SELECT a.*, s.anon_code FROM allocations a JOIN subjects s ON s.id = a.subject_id
     WHERE a.subject_id = ? ORDER BY a.allocated_at DESC LIMIT 1`,
  ).all(subjectId) as (Record<string, unknown> & { anon_code: string })[];
  const allocation = rows[0];
  if (!allocation) throw ERR.notFound("allocation");
  const operatorId = ctx.operatorId;
  if (!operatorId) throw ERR.forbidden("operator identity required");
  const operator = ctx.db.prepare("SELECT id FROM operators WHERE id = ?").get(operatorId);
  if (!operator) throw ERR.forbidden("unknown operator");
  const nowIso = ctx.clock.now().toISOString();
  withTransaction(ctx.db, () => {
    ctx.db.prepare(
      "INSERT INTO unblinding_events(id, allocation_id, operator_id, reason, justification, created_at) VALUES (?,?,?,?,?,?)",
    ).run(newId(), String(allocation.id), operatorId, reason, justification, nowIso);
    appendAudit(ctx.db, {
      entityType: "unblinding", entityId: String(allocation.id), action: reason,
      payload: { subjectId, justification }, operatorId,
    }, nowIso);
  });
  return {
    allocationId: String(allocation.id), subjectId, anonCode: allocation.anon_code,
    arm: allocation.arm as Arm, status: String(allocation.status), allocatedAt: String(allocation.allocated_at),
  };
}

export function maskedAllocation(ctx: TrialContext, subjectId: string): AllocationView {
  const row = ctx.db.prepare(
    `SELECT a.*, s.anon_code FROM allocations a JOIN subjects s ON s.id = a.subject_id
     WHERE a.subject_id = ? ORDER BY a.allocated_at DESC LIMIT 1`,
  ).get(subjectId) as (Record<string, unknown> & { anon_code: string }) | undefined;
  if (!row) throw ERR.notFound("allocation");
  return {
    allocationId: String(row.id), subjectId, anonCode: row.anon_code,
    status: String(row.status), allocatedAt: String(row.allocated_at),
  };
}
