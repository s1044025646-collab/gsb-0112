import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createAppContext, closeAppContext } from "../src/app/context.ts";
import { installFictionalTrial } from "../src/fixtures/fictional-trial.ts";
import { registerScreen, withdrawConsent } from "../src/services/subject-service.ts";
import { allocate, markRandomizedInError, maskedAllocation, unblind } from "../src/services/randomization-service.ts";
import { scheduleVisit, recordVisit } from "../src/services/visit-service.ts";
import { verifyAuditChain } from "../src/domain/audit.ts";

const dbFile = resolve("data/demo.db");
mkdirSync("data", { recursive: true });
rmSync(dbFile, { force: true });
rmSync(`${dbFile}-wal`, { force: true });
rmSync(`${dbFile}-shm`, { force: true });

const clock = (() => {
  let t = new Date("2026-01-05T08:00:00Z");
  return {
    now: () => new Date(t),
    addDays: (n: number) => {
      t = new Date(t.getTime() + n * 86_400_000);
    },
  };
})();

const ctx = createAppContext({ filename: dbFile, clock });
const say = (step: string, value: unknown) => console.log(`\n== ${step} ==\n${JSON.stringify(value, null, 2)}`);

try {
  const fx = installFictionalTrial(ctx);
  say("1. fictional trial installed (3 sites, 2x2 strata, v1.0/v2.0 windows, 3 blinded roles)", {
    trial: fx.trialCode, sites: ["BJ01", "SH01", "WQ01"], v2EffectiveAt: "baseline + 40 days",
  });

  const asCoord = { ...ctx, operatorId: fx.operators.coordinator };
  const asAdmin = { ...ctx, operatorId: fx.operators.admin };

  const screen = (siteCode: string, strata: Record<string, string>, criteria: Record<string, boolean> = {
    inclusion_age: true, inclusion_diagnosis: true, exclusion_pregnancy: true,
  }) =>
    registerScreen(asCoord, {
      trialCode: fx.trialCode, siteCode, strata, criteria,
      consentSignedAt: new Date(clock.now().getTime() - 3600_000),
    });

  say("2. screening failure is refused at allocation", (() => {
    const failed = screen("BJ01", { age_band: ">=65", disease_stage: "III" }, { inclusion_age: false, inclusion_diagnosis: true, exclusion_pregnancy: true });
    let errorCode = "";
    try { allocate(asCoord, failed.subjectId); } catch (e) { errorCode = (e as { code: string }).code; }
    return { subject: failed.anonCode, eligible: failed.eligible, allocationError: errorCode };
  })());

  const withdrawn = screen("BJ01", { age_band: "<65", disease_stage: "II" });
  withdrawConsent(asCoord, withdrawn.subjectId);
  say("3. consent withdrawn -> allocation refused", (() => {
    let errorCode = "";
    try { allocate(asCoord, withdrawn.subjectId); } catch (e) { errorCode = (e as { code: string }).code; }
    return { subject: withdrawn.anonCode, error: errorCode };
  })());

  const stratified: Record<string, number> = {};
  const enrolled: { id: string; code: string; site: string }[] = [];
  const combos = [
    ["BJ01", { age_band: "<65", disease_stage: "II" }],
    ["BJ01", { age_band: ">=65", disease_stage: "III" }],
    ["SH01", { age_band: "<65", disease_stage: "II" }],
    ["WQ01", { age_band: "<65", disease_stage: "II" }],
  ] as const;
  for (let i = 0; i < 8; i++) {
    const [siteCode, strata] = combos[i % combos.length]!;
    const s = screen(siteCode, strata as Record<string, string>);
    const a = allocate(asCoord, s.subjectId);
    stratified[`${siteCode}:${s.subjectId ? "" : ""}${Object.entries(strata).map(([k, v]) => `${k}=${v}`).join("|")}`] =
      (stratified[`${siteCode}:${Object.entries(strata).map(([k, v]) => `${k}=${v}`).join("|")}`] ?? 0) + 1;
    enrolled.push({ id: s.subjectId, code: s.anonCode, site: siteCode });
  }

  const sequenceTable = ctx.db.prepare(
    `SELECT si.code AS site, a.stratum_signature AS stratum, a.sequence_index AS seq, a.block_index AS block, a.arm
     FROM allocations a JOIN sites si ON si.id = a.site_id ORDER BY si.code, a.stratum_signature, a.sequence_index`,
  ).all();
  say("4. reproducible per-site/per-stratum block allocation (shown unmasked only here in the offline demo)", sequenceTable);

  const errSubject = enrolled[0]!;
  markRandomizedInError(asAdmin, errSubject.id, "fictional: paperwork filed under wrong site");
  const replacement = screen("BJ01", { age_band: "<65", disease_stage: "II" });
  allocate(asCoord, replacement.subjectId);
  const indices = (ctx.db.prepare("SELECT sequence_index AS s FROM allocations WHERE site_id=(SELECT id FROM sites WHERE code='BJ01') AND stratum_signature='age_band=<65|disease_stage=II' ORDER BY sequence_index").all() as { s: number }[]).map((r) => r.s);
  say("5. randomization-in-error keeps the consumed number; replacement takes the next one", {
    inError: errSubject.code, replacement: replacement.anonCode, indicesUsed: indices,
  });

  const emergency = enrolled[1]!;
  say("6. coordinator view stays masked", maskedAllocation(asCoord, emergency.id));
  const revealed = unblind(asAdmin, emergency.id, "fictional emergency: suspected (imaginary) infusion reaction", "emergency", "unblinded_admin");
  say("7. emergency unblinding by unblinded_admin writes an independent audit record", revealed);

  const v3Subject = enrolled[2]!;
  scheduleVisit(asCoord, v3Subject.id, "V3_WEEK12", clock.now());
  clock.addDays(95);
  const lateVisit = recordVisit(asCoord, v3Subject.id, "V3_WEEK12", clock.now());
  say("8. late visit recorded after protocol v2.0 became effective; deviation pinned to versions at event time", lateVisit);

  const chain = verifyAuditChain(ctx.db);
  const summary = ctx.db.prepare("SELECT action, COUNT(*) AS c FROM audit_log GROUP BY action ORDER BY action").all();
  say("9. audit summary", {
    chain, entriesByAction: summary,
    unblindingEvents: ctx.db.prepare("SELECT reason, justification, created_at FROM unblinding_events").all(),
    deviations: ctx.db.prepare("SELECT kind, protocol_version_id, event_at FROM deviations").all(),
  });

  if (!chain.ok) throw new Error("audit chain broken");
  console.log("\nDEMO OK - repeatable; database written to data/demo.db");
} finally {
  closeAppContext(ctx);
}
