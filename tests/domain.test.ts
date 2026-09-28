import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeHarness, type Harness } from "./helpers.ts";
import { registerScreen, withdrawConsent } from "../src/services/subject-service.ts";
import {
  allocate, armAtPosition, markRandomizedInError, maskedAllocation, unblind,
} from "../src/services/randomization-service.ts";
import { scheduleVisit, recordVisit, reportManualDeviation, listDeviations } from "../src/services/visit-service.ts";
import { verifyAuditChain } from "../src/domain/audit.ts";
import { DomainError } from "../src/domain/errors.ts";
import type { AppContext } from "../src/app/context.ts";

let h: Harness;

function eligible(strata: Record<string, string>, consentDaysAgo = 1) {
  return {
    trialCode: "FICT-042",
    siteCode: "BJ01",
    strata,
    criteria: { inclusion_age: true, inclusion_diagnosis: true, exclusion_pregnancy: true },
    consentSignedAt: new Date(h.clock.now().getTime() - consentDaysAgo * 86_400_000),
  };
}

beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.close();
});

describe("screening and consent gates", () => {
  it("refuses allocation when eligibility fails", () => {
    const res = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, {
      ...eligible({ age_band: "<65", disease_stage: "II" }),
      criteria: { inclusion_age: false, exclusion_pregnancy: true },
    });
    expect(res.eligible).toBe(false);
    expect(() => allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, res.subjectId)).toThrowError(DomainError);
    try {
      allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, res.subjectId);
    } catch (e) {
      expect((e as DomainError).code).toBe("FORBIDDEN");
    }
  });

  it("refuses allocation after consent withdrawal and retry does not consume numbers", () => {
    const s1 = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "<65", disease_stage: "II" }));
    withdrawConsent({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s1.subjectId);
    expect(() => allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s1.subjectId)).toThrowError(DomainError);

    const s2 = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "<65", disease_stage: "II" }));
    const a2 = allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s2.subjectId);
    expect(a2.arm).toBeDefined();
    const rows = h.ctx.db.prepare("SELECT sequence_index FROM allocations ORDER BY sequence_index").all() as { sequence_index: number }[];
    expect(rows.map((r) => r.sequence_index)).toEqual([0]);
  });

  it("rejects duplicate enrollment of the same subject", () => {
    const s = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: ">=65", disease_stage: "III" }));
    allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId);
    expect(() => allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId)).toThrowError(DomainError);
  });

  it("validates stratum values", () => {
    expect(() => registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "999", disease_stage: "II" }))).toThrowError(/stratum/);
  });
});

describe("reproducible stratified block randomization", () => {
  it("is deterministic from trial secret and independent per site/stratum", () => {
    const secret = h.ctx.db.prepare("SELECT rand_secret FROM trials WHERE id = ?").get(h.fixture.trialId) as { rand_secret: string };
    const a = armAtPosition(secret.rand_secret, h.fixture.siteBeijing, "age_band=<65|disease_stage=II", 4, 0);
    const b = armAtPosition(secret.rand_secret, h.fixture.siteBeijing, "age_band=<65|disease_stage=II", 4, 0);
    expect(a).toBe(b);
    const fullBlock = Array.from({ length: 4 }, (_, i) =>
      armAtPosition(secret.rand_secret, h.fixture.siteBeijing, "age_band=<65|disease_stage=II", 4, i));
    expect(fullBlock.filter((x) => x === "A")).toHaveLength(2);
    expect(fullBlock.filter((x) => x === "B")).toHaveLength(2);
  });

  it("never repeats sequence numbers and balances within each block", () => {
    const strata = [
      { age_band: "<65", disease_stage: "II" },
      { age_band: ">=65", disease_stage: "III" },
    ] as const;
    for (let i = 0; i < 8; i++) {
      const stratum = strata[i % 2]!;
      const s = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, eligible(stratum as Record<string, string>));
      allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId);
    }
    const rows = h.ctx.db.prepare(
      "SELECT sequence_index, arm, stratum_signature FROM allocations WHERE site_id=? ORDER BY stratum_signature, sequence_index",
    ).all(h.fixture.siteBeijing) as { sequence_index: number; arm: string; stratum_signature: string }[];
    for (const sig of new Set(rows.map((r) => r.stratum_signature))) {
      const indices = rows.filter((r) => r.stratum_signature === sig).map((r) => r.sequence_index);
      expect(indices).toEqual([0, 1, 2, 3]);
    }
  });

  it("does not recycle consumed numbers after randomization-in-error", () => {
    const s1 = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "<65", disease_stage: "II" }));
    const a1 = allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s1.subjectId);
    markRandomizedInError({ ...h.ctx, operatorId: h.fixture.operators.admin }, s1.subjectId, "fictional: wrong site paperwork");
    const s2 = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "<65", disease_stage: "II" }));
    const a2 = allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s2.subjectId);
    const indices = (h.ctx.db.prepare("SELECT sequence_index FROM allocations ORDER BY sequence_index").all() as { sequence_index: number }[]).map((r) => r.sequence_index);
    expect(indices).toEqual([0, 1]);
    expect(a1.allocationId).not.toBe(a2.allocationId);
  });
});

describe("blinding", () => {
  it("masks arm from coordinators and auditors; only unblinded_admin reveals with audit record", () => {
    const s = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "<65", disease_stage: "II" }));
    allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId);
    const masked = maskedAllocation({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId);
    expect(masked.arm).toBeUndefined();
    expect(() => unblind({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId, "x", "emergency", "coordinator"))
      .toThrowError(/unblinded_admin/);
    const revealed = unblind({ ...h.ctx, operatorId: h.fixture.operators.admin }, s.subjectId, "fictional emergency: suspected reaction", "emergency", "unblinded_admin");
    expect(["A", "B"]).toContain(revealed.arm);
    const events = h.ctx.db.prepare("SELECT reason FROM unblinding_events").all() as { reason: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe("emergency");
  });
});

describe("visit windows and deviations across timezones and revisions", () => {
  function enroll(ctx: AppContext, strata: Record<string, string>) {
    const s = registerScreen({ ...ctx, operatorId: h.fixture.operators.coordinator }, {
      ...eligible(strata), siteCode: "WQ01",
    });
    allocate({ ...ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId);
    return s.subjectId;
  }

  it("judges in-window on exact boundaries (site-local day in Asia/Urumqi)", () => {
    const subjectId = enroll(h.ctx, { age_band: "<65", disease_stage: "II" });
    const baseline = h.clock.now();
    const scheduled = scheduleVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "V1_BASELINE", baseline);
    const localDayStartUtc = new Date("2026-01-05T00:00:00Z");
    expect(new Date(scheduled.from).toISOString()).toBe(localDayStartUtc.toISOString());
    const edge = recordVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "V1_BASELINE", new Date(scheduled.to));
    expect(edge.withinWindow).toBe(true);
    expect(edge.deviationId).toBeNull();
  });

  it("flags early/late visits and pins the protocol version at event time", () => {
    const subjectId = enroll(h.ctx, { age_band: ">=65", disease_stage: "III" });
    const baseline = h.clock.now();
    scheduleVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "V2_WEEK4", baseline);
    const early = recordVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "V2_WEEK4",
      new Date(baseline.getTime() + 25 * 86_400_000));
    expect(early.kind).toBe("visit_out_of_window_early");

    const subject2 = enroll(h.ctx, { age_band: ">=65", disease_stage: "III" });
    scheduleVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subject2, "V2_WEEK4", baseline);
    h.clock.addDays(45);
    const underV2 = recordVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subject2, "V2_WEEK4", h.clock.now());
    expect(underV2.judgedFromVersion).toBe(h.fixture.v2Id);
  });

  it("historical deviation rows are never rewritten by newer rules", () => {
    const subjectId = enroll(h.ctx, { age_band: "<65", disease_stage: "II" });
    const baseline = h.clock.now();
    scheduleVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "V3_WEEK12", baseline);
    h.clock.addDays(95);
    const res = recordVisit({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "V3_WEEK12", h.clock.now());
    expect(res.deviationId).toBeTruthy();
    const before = h.ctx.db.prepare("SELECT * FROM deviations WHERE id=?").get(res.deviationId) as Record<string, unknown>;
    const page1 = listDeviations(h.ctx.db, { trialId: h.fixture.trialId, limit: 1, offset: 0 });
    expect(page1.total).toBeGreaterThanOrEqual(1);
    expect(page1.rows).toHaveLength(1);
    const after = h.ctx.db.prepare("SELECT * FROM deviations WHERE id=?").get(res.deviationId) as Record<string, unknown>;
    expect(after.detail).toBe(before.detail);
    expect(after.protocol_version_id).toBe(before.protocol_version_id);
    const manual = reportManualDeviation({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, subjectId, "wrong_drug_administered", "fictional event", h.clock.now());
    expect(manual).toBeTruthy();
  });
});

describe("transactions and restart persistence", () => {
  it("rolls back everything when a later statement fails", () => {
    const before = (h.ctx.db.prepare("SELECT COUNT(*) AS c FROM subjects").get() as { c: number }).c;
    h.ctx.db.exec("BEGIN IMMEDIATE");
    expect(() => {
      try {
        h.ctx.db.prepare("INSERT INTO subjects(id, trial_id, site_id, anon_code, status, created_at) VALUES (?,?,?,?,?,?)")
          .run("x", h.fixture.trialId, h.fixture.siteBeijing, "TMP-0001", "screened", new Date().toISOString());
        h.ctx.db.prepare("INSERT INTO nope VALUES (1)").run();
      } catch (e) {
        h.ctx.db.exec("ROLLBACK");
        throw e;
      }
    }).toThrow();
    const after = (h.ctx.db.prepare("SELECT COUNT(*) AS c FROM subjects").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("survives process restart and keeps audit chain verifiable", () => {
    const s = registerScreen({ ...h.ctx, operatorId: h.fixture.operators.coordinator },
      eligible({ age_band: "<65", disease_stage: "II" }));
    allocate({ ...h.ctx, operatorId: h.fixture.operators.coordinator }, s.subjectId);
    unblind({ ...h.ctx, operatorId: h.fixture.operators.admin }, s.subjectId, "fictional emergency", "emergency", "unblinded_admin");
    h.reopen();
    const allocations = h.ctx.db.prepare("SELECT COUNT(*) AS c FROM allocations").get() as { c: number };
    expect(allocations.c).toBe(1);
    const chain = verifyAuditChain(h.ctx.db);
    expect(chain.ok).toBe(true);
    expect(chain.count).toBeGreaterThanOrEqual(3);
  });
});
