#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAppContext, closeAppContext } from "../app/context.ts";
import { installFictionalTrial } from "../fixtures/fictional-trial.ts";
import { verifyAuditChain } from "../domain/audit.ts";
import { ensureOperator } from "../services/operator-service.ts";
import { createTrial, getTrialByCode, addSite, addStratum } from "../services/trial-service.ts";
import { registerScreen, withdrawConsent } from "../services/subject-service.ts";
import { allocate, maskedAllocation, unblind, markRandomizedInError } from "../services/randomization-service.ts";
import { scheduleVisit, recordVisit, reportManualDeviation } from "../services/visit-service.ts";
import { DomainError } from "../domain/errors.ts";

interface ParsedArgs {
  command: string;
  flags: Map<string, string>;
}

function parse(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return { command, flags };
}

function requireFlag(flags: Map<string, string>, key: string): string {
  const v = flags.get(key);
  if (v === undefined) throw new DomainError("VALIDATION_ERROR", `missing --${key}`, 422);
  return v;
}

function jsonFlags(flags: Map<string, string>, key: string): Record<string, string> {
  const raw = requireFlag(flags, key);
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DomainError("VALIDATION_ERROR", `--${key} must be a JSON object`, 422);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "string") throw new DomainError("VALIDATION_ERROR", `--${key}.${k} must be string`, 422);
    out[k] = v;
  }
  return out;
}

function subjectSnapshot(ctx: ReturnType<typeof createAppContext>, subjectId: string) {
  return ctx.db.prepare(
    `SELECT s.anon_code AS anonCode, s.status, pv.version AS protocolVersion,
            (SELECT COUNT(*) FROM allocations a WHERE a.subject_id=s.id) AS allocations,
            (SELECT kind || ':' || signed_at FROM consent_events WHERE subject_id=s.id ORDER BY signed_at DESC, rowid DESC LIMIT 1) AS latestConsent
     FROM subjects s JOIN protocol_versions pv ON pv.id = (SELECT current_protocol_version_id FROM trials WHERE id=s.trial_id)
     WHERE s.id = ?`,
  ).get(subjectId);
}

function print(label: string, value: unknown): void {
  console.log(`--- ${label} ---`);
  console.log(JSON.stringify(value, null, 2));
}

const USAGE = `trial-cli <command> [flags]
Commands:
  init-db                 Create/migrate database (idempotent) and show migration state
  seed-fixtures           Install the fully fictional FICT-042 trial, sites, strata, windows, operators
  trial-create            --code --name --block-size
  site-add                --trial --code --name --timezone
  stratum-add             --trial --factor --value
  screen                  --trial --site --strata-json --criteria-json --consent-at --operator
  status                  --subject-id
  allocate                --subject-id --operator
  withdraw                --subject-id --operator
  randomized-in-error     --subject-id --justification --operator (must be unblinded admin username)
  visit-schedule          --subject-id --visit --baseline-at --operator
  visit-record            --subject-id --visit --occurred-at --operator
  deviation-report        --subject-id --kind --detail --event-at --operator
  unblind                 --subject-id --justification --reason --operator (unblinded admin)
  audit-summary           [--limit] export audit summary and chain verification
  help

Environment:
  TRIAL_DB   SQLite file path (default: data/trial.db)`;

async function run(): Promise<number> {
  const args = parse(process.argv.slice(2));
  const dbFile = resolve(process.env.TRIAL_DB ?? "data/trial.db");
  if (args.command !== "help") mkdirSync(dirname(dbFile), { recursive: true });
  const ctx = createAppContext({ filename: dbFile });
  try {
    const asCtx = (operatorUsername?: string) => {
      if (!operatorUsername) return ctx;
      const role = args.flags.get("role") ?? "coordinator";
      if (!["coordinator", "unblinded_admin", "auditor"].includes(role)) {
        throw new DomainError("VALIDATION_ERROR", "invalid --role", 422);
      }
      const operatorId = ensureOperator(ctx, operatorUsername, role as "coordinator");
      return { ...ctx, operatorId };
    };

    switch (args.command) {
      case "help":
        console.log(USAGE);
        break;
      case "init-db": {
        const v = ctx.db.prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version").all();
        print("migrations", { dbFile, versions: v });
        break;
      }
      case "seed-fixtures": {
        const count = (ctx.db.prepare("SELECT COUNT(*) AS c FROM trials").get() as { c: number }).c;
        if (count > 0) throw new DomainError("FIXTURES_EXIST", "database already contains trials; refusing to duplicate", 409);
        const handle = installFictionalTrial(ctx);
        print("fixtures installed", handle);
        break;
      }
      case "trial-create": {
        const trial = createTrial(asCtx(args.flags.get("operator")), {
          code: requireFlag(args.flags, "code"),
          name: requireFlag(args.flags, "name"),
          blockSize: Number(requireFlag(args.flags, "block-size")),
        });
        print("trial created", trial);
        break;
      }
      case "site-add": {
        const trial = getTrialByCode(ctx, requireFlag(args.flags, "trial"));
        const site = addSite(asCtx(args.flags.get("operator")), String(trial.id),
          requireFlag(args.flags, "code"), requireFlag(args.flags, "name"), requireFlag(args.flags, "timezone"));
        print("site added", site);
        break;
      }
      case "stratum-add": {
        const trial = getTrialByCode(ctx, requireFlag(args.flags, "trial"));
        const id = addStratum(asCtx(args.flags.get("operator")), String(trial.id),
          requireFlag(args.flags, "factor"), requireFlag(args.flags, "value"));
        print("stratum added", { id });
        break;
      }
      case "screen": {
        const before = { subjects: (ctx.db.prepare("SELECT COUNT(*) AS c FROM subjects").get() as { c: number }).c };
        const result = registerScreen(asCtx(args.flags.get("operator")), {
          trialCode: requireFlag(args.flags, "trial"),
          siteCode: requireFlag(args.flags, "site"),
          strata: jsonFlags(args.flags, "strata-json"),
          criteria: JSON.parse(requireFlag(args.flags, "criteria-json")) as Record<string, boolean>,
          consentSignedAt: new Date(requireFlag(args.flags, "consent-at")),
        });
        print("before", before);
        print("screening result", result);
        print("after", subjectSnapshot(ctx, result.subjectId));
        break;
      }
      case "status": {
        print("subject", subjectSnapshot(ctx, requireFlag(args.flags, "subject-id")));
        print("allocation (masked unless operator is unblinded admin)", maskedAllocation(asCtx(args.flags.get("operator")),
          requireFlag(args.flags, "subject-id")));
        break;
      }
      case "allocate": {
        const subjectId = requireFlag(args.flags, "subject-id");
        print("before", subjectSnapshot(ctx, subjectId));
        const result = allocate(asCtx(args.flags.get("operator")), subjectId);
        const role = args.flags.get("role") ?? "coordinator";
        print("allocation result", role === "unblinded_admin" ? result : { ...result, arm: undefined });
        print("after", subjectSnapshot(ctx, subjectId));
        break;
      }
      case "withdraw": {
        const subjectId = requireFlag(args.flags, "subject-id");
        print("before", subjectSnapshot(ctx, subjectId));
        withdrawConsent(asCtx(args.flags.get("operator")), subjectId);
        print("after", subjectSnapshot(ctx, subjectId));
        break;
      }
      case "randomized-in-error": {
        const subjectId = requireFlag(args.flags, "subject-id");
        args.flags.set("role", "unblinded_admin");
        print("before", subjectSnapshot(ctx, subjectId));
        markRandomizedInError(asCtx(args.flags.get("operator")), subjectId, requireFlag(args.flags, "justification"));
        print("after", subjectSnapshot(ctx, subjectId));
        break;
      }
      case "visit-schedule": {
        const subjectId = requireFlag(args.flags, "subject-id");
        const result = scheduleVisit(asCtx(args.flags.get("operator")), subjectId,
          requireFlag(args.flags, "visit"), new Date(requireFlag(args.flags, "baseline-at")));
        print("visit scheduled", result);
        break;
      }
      case "visit-record": {
        const subjectId = requireFlag(args.flags, "subject-id");
        const result = recordVisit(asCtx(args.flags.get("operator")), subjectId,
          requireFlag(args.flags, "visit"), new Date(requireFlag(args.flags, "occurred-at")));
        print("visit recorded", result);
        break;
      }
      case "deviation-report": {
        const id = reportManualDeviation(asCtx(args.flags.get("operator")),
          requireFlag(args.flags, "subject-id"), requireFlag(args.flags, "kind"),
          requireFlag(args.flags, "detail"), new Date(requireFlag(args.flags, "event-at")));
        print("deviation recorded", { id });
        break;
      }
      case "unblind": {
        args.flags.set("role", "unblinded_admin");
        const result = unblind(asCtx(args.flags.get("operator")), requireFlag(args.flags, "subject-id"),
          requireFlag(args.flags, "justification"), requireFlag(args.flags, "reason") as "emergency", "unblinded_admin");
        print("UNBLINDED", result);
        break;
      }
      case "audit-summary": {
        const limit = Number(args.flags.get("limit") ?? "20");
        const rows = ctx.db.prepare(
          "SELECT id, entity_type AS entityType, entity_id AS entityId, action, operator_id AS operatorId, created_at AS createdAt FROM audit_log ORDER BY id DESC LIMIT ?",
        ).all(limit);
        const counts = ctx.db.prepare(
          `SELECT action, COUNT(*) AS c FROM audit_log GROUP BY action ORDER BY action`,
        ).all();
        print("audit summary", { total: (ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log").get() as { c: number }).c, counts, recent: rows });
        print("chain verification", verifyAuditChain(ctx.db));
        const unblindings = ctx.db.prepare(
          "SELECT id, reason, justification, operator_id AS operatorId, created_at AS createdAt FROM unblinding_events ORDER BY created_at",
        ).all();
        print("unblinding events", unblindings);
        break;
      }
      default:
        console.error(`unknown command: ${args.command}\n\n${USAGE}`);
        return 2;
    }
    return 0;
  } finally {
    closeAppContext(ctx);
  }
}

run().catch((err) => {
  if (err instanceof DomainError) {
    console.error(JSON.stringify({ error: { code: err.code, message: err.message } }));
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
