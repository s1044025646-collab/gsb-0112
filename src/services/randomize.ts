import { createHmac } from "node:crypto";
import type { DB } from "../db.js";

/**
 * Deterministic permuted-block randomization.
 *
 * For each (site, stratum) the arm order inside block N is a
 * Fisher-Yates shuffle driven by HMAC-SHA256(trial_seed, site|stratum|N).
 * Given the seed the whole sequence is reproducible; without the seed an
 * operator cannot predict upcoming allocations.
 */
export function blockArms(
  seed: string,
  siteKey: string,
  stratumKey: string,
  blockNo: number,
  arms: string[],
  blockSize: number
): string[] {
  // Build the block: repeat arms evenly, pad remainder from the front.
  const block: string[] = [];
  const per = Math.floor(blockSize / arms.length);
  for (const arm of arms) for (let i = 0; i < per; i++) block.push(arm);
  let extra = blockSize - block.length;
  for (let i = 0; extra > 0; i = (i + 1) % arms.length, extra--) block.push(arms[i]);

  const hmac = createHmac("sha256", seed)
    .update(`${siteKey}|${stratumKey}|${blockNo}`)
    .digest();
  // Fisher-Yates with key-stream bytes from the HMAC digest.
  for (let i = block.length - 1; i > 0; i--) {
    const j = hmac[i % hmac.length] % (i + 1);
    [block[i], block[j]] = [block[j], block[i]];
  }
  return block;
}

/** Ensure at least `minAvailable` unconsumed slots exist for (site, stratum). */
export function ensurePool(
  db: DB,
  trial: { id: number; seed: string; arms: string; block_size: number },
  siteId: number,
  siteCode: string,
  stratumKey: string,
  minAvailable: number
): void {
  const arms = JSON.parse(trial.arms) as string[];
  const row = db
    .prepare(
      `SELECT COUNT(*) AS avail, COALESCE(MAX(seq_no), 0) AS maxSeq
       FROM random_sequences
       WHERE trial_id = ? AND site_id = ? AND stratum_key = ?`
    )
    .get(trial.id, siteId, stratumKey) as { avail: number; maxSeq: number };
  const availRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM random_sequences
       WHERE trial_id = ? AND site_id = ? AND stratum_key = ? AND status = 'available'`
    )
    .get(trial.id, siteId, stratumKey) as { c: number };

  let needed = minAvailable - availRow.c;
  let seq = row.maxSeq;
  while (needed > 0) {
    const blockNo = Math.floor(seq / trial.block_size);
    const block = blockArms(trial.seed, siteCode, stratumKey, blockNo, arms, trial.block_size);
    for (const arm of block) {
      seq++;
      db.prepare(
        `INSERT INTO random_sequences (trial_id, site_id, stratum_key, seq_no, block_no, arm)
         VALUES (?,?,?,?,?,?)`
      ).run(trial.id, siteId, stratumKey, seq, blockNo, arm);
    }
    needed -= block.length;
  }
}

/** Take the next available slot. Consumed slots are never recycled. */
export function consumeNext(
  db: DB,
  trialId: number,
  siteId: number,
  stratumKey: string,
  subjectId: number,
  now: Date
): { sequenceId: number; arm: string; seqNo: number } | null {
  const slot = db
    .prepare(
      `SELECT id, arm, seq_no FROM random_sequences
       WHERE trial_id = ? AND site_id = ? AND stratum_key = ? AND status = 'available'
       ORDER BY seq_no LIMIT 1`
    )
    .get(trialId, siteId, stratumKey) as
    | { id: number; arm: string; seq_no: number }
    | undefined;
  if (!slot) return null;
  const res = db
    .prepare(
      `UPDATE random_sequences
       SET status = 'consumed', consumed_by = ?, consumed_at = ?
       WHERE id = ? AND status = 'available'`
    )
    .run(subjectId, now.toISOString(), slot.id);
  if (res.changes !== 1) return null; // lost a race; caller retries/rolls back
  return { sequenceId: slot.id, arm: slot.arm, seqNo: slot.seq_no };
}
