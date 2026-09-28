import type { AppContext } from "../app/context.ts";
import { createTrial, addSite, addStratum, addProtocolVersion } from "../services/trial-service.ts";
import { addVisitWindow, type WindowSpec } from "../services/visit-service.ts";
import { ensureOperator } from "../services/operator-service.ts";

export interface FixtureHandle {
  trialId: string;
  trialCode: string;
  v1Id: string;
  v2Id: string;
  siteBeijing: string;
  siteShanghai: string;
  siteUrumqi: string;
  operators: { coordinator: string; admin: string; auditor: string };
}

export function installFictionalTrial(ctx: AppContext): FixtureHandle {
  const operators = {
    coordinator: ensureOperator(ctx, "fic-coord", "coordinator"),
    admin: ensureOperator(ctx, "fic-admin", "unblinded_admin"),
    auditor: ensureOperator(ctx, "fic-auditor", "auditor"),
  };

  const trial = createTrial({ ...ctx, operatorId: operators.coordinator }, {
    code: "FICT-042",
    name: "FICT-042 Placebo vs Compound ZX-7 (entirely fictional)",
    blockSize: 4,
    version: "v1.0",
  });
  const trialId = String(trial.id);
  const v1Id = String(trial.current_protocol_version_id);

  addStratum({ ...ctx, operatorId: operators.coordinator }, trialId, "age_band", "<65");
  addStratum({ ...ctx, operatorId: operators.coordinator }, trialId, "age_band", ">=65");
  addStratum({ ...ctx, operatorId: operators.coordinator }, trialId, "disease_stage", "II");
  addStratum({ ...ctx, operatorId: operators.coordinator }, trialId, "disease_stage", "III");

  const bj = addSite({ ...ctx, operatorId: operators.coordinator }, trialId, "BJ01", "Fictional Capital Research Center", "Asia/Shanghai") as { id: string };
  const sh = addSite({ ...ctx, operatorId: operators.coordinator }, trialId, "SH01", "Fictional Harbor Study Unit", "Asia/Shanghai") as { id: string };
  const wq = addSite({ ...ctx, operatorId: operators.coordinator }, trialId, "WQ01", "Fictional Frontier Clinic", "Asia/Urumqi") as { id: string };

  const v1Windows: WindowSpec[] = [
    { visitCode: "V1_BASELINE", offsetDays: 0, windowLowDays: 0, windowHighDays: 2 },
    { visitCode: "V2_WEEK4", offsetDays: 28, windowLowDays: 2, windowHighDays: 3 },
    { visitCode: "V3_WEEK12", offsetDays: 84, windowLowDays: 3, windowHighDays: 7 },
  ];
  for (const w of v1Windows) addVisitWindow({ ...ctx, operatorId: operators.coordinator }, v1Id, w);

  const revisionDate = new Date(ctx.clock.now().getTime() + 40 * 86_400_000);
  const v2 = addProtocolVersion({ ...ctx, operatorId: operators.admin }, trialId, "v2.0", 6, revisionDate);
  const v2Id = String(v2.id);
  const v2Windows: WindowSpec[] = [
    { visitCode: "V1_BASELINE", offsetDays: 0, windowLowDays: 0, windowHighDays: 2 },
    { visitCode: "V2_WEEK4", offsetDays: 28, windowLowDays: 3, windowHighDays: 5 },
    { visitCode: "V3_WEEK12", offsetDays: 84, windowLowDays: 5, windowHighDays: 10 },
  ];
  for (const w of v2Windows) addVisitWindow({ ...ctx, operatorId: operators.admin }, v2Id, w);

  return {
    trialId, trialCode: "FICT-042", v1Id, v2Id,
    siteBeijing: String(bj.id), siteShanghai: String(sh.id), siteUrumqi: String(wq.id),
    operators,
  };
}
