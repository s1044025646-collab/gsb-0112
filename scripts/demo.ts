/** Repeatable end-to-end demo with fully fictional data. */
import { rmSync } from "node:fs";
import { openDb } from "../src/db.js";
import { mutableClock } from "../src/context.js";
import { loadFixtures } from "../fixtures/fictional.js";
import { verifyChain } from "../src/audit.js";

const path = "demo.db";
for (const suffix of ["", "-wal", "-shm"]) {
  try { rmSync(path + suffix); } catch {}
}

const clock = mutableClock("2026-01-05T01:00:00Z");
const db = openDb(path);

console.log("== CTRS end-to-end demo (fictional data only) ==\n");
const ids = loadFixtures(db, clock.ctx, (m) => console.log("  " + m));

console.log("\n== audit chains ==");
for (const chain of ["main", "withdrawal", "misrandomization", "unblinding"] as const) {
  const n = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE chain = ?").get(chain) as any).c;
  console.log(`  ${chain}: ${n} entries, intact=${verifyChain(db, chain)}`);
}

console.log("\n== deviations ==");
for (const d of db.prepare("SELECT id, subject_id, type, protocol_version, description FROM deviations").all() as any[]) {
  console.log(`  #${d.id} subject=${d.subject_id} [${d.protocol_version}] ${d.type}: ${d.description}`);
}

console.log("\n== randomization pool (consumed numbers are never recycled) ==");
for (const r of db.prepare(
  "SELECT site_id, stratum_key, seq_no, arm, status FROM random_sequences ORDER BY site_id, stratum_key, seq_no"
).all() as any[]) {
  console.log(`  site=${r.site_id} ${r.stratum_key} seq=${r.seq_no} arm=${r.arm} ${r.status}`);
}

db.close();
console.log(`\ndemo complete. database: ${path} (delete it to re-run cleanly)`);
console.log("subject ids:", JSON.stringify(ids.subjects));
