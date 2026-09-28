#!/usr/bin/env node
import { openDb } from "./db.js";
import { systemCtx } from "./context.js";
import * as trialSvc from "./services/trial.js";
import * as subjectSvc from "./services/subject.js";
import * as visitSvc from "./services/visit.js";
import * as unblindSvc from "./services/unblind.js";
import { verifyChain } from "./audit.js";

const dbPath = process.env.CTRS_DB ?? "ctrs.db";
const db = openDb(dbPath);
const ctx = systemCtx;

function parseArgs(argv: string[]): { cmd: string[]; opts: Record<string, string> } {
  const cmd: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = "true";
      }
    } else cmd.push(a);
  }
  return { cmd, opts };
}

function subjectState(id: number): string {
  const s = db.prepare(
    `SELECT s.id, s.anon_code, s.status,
            (SELECT arm FROM assignments a WHERE a.subject_id = s.id) AS arm
     FROM subjects s WHERE s.id = ?`
  ).get(id) as any;
  if (!s) return `subject ${id}: <not found>`;
  return `subject ${s.id} [${s.anon_code}] status=${s.status} arm=${s.arm ?? "(hidden/none)"}`;
}

function need(opts: Record<string, string>, ...keys: string[]): void {
  for (const k of keys) if (!(k in opts)) throw new Error(`missing --${k}`);
}

const { cmd, opts } = parseArgs(process.argv.slice(2));
const actor = opts.actor ?? "cli-admin";

try {
  switch (cmd.join(" ")) {
    case "trial create": {
      need(opts, "code", "title", "arms", "block-size");
      const r = trialSvc.createTrial(db, ctx, {
        code: opts.code,
        title: opts.title,
        arms: opts.arms.split(","),
        blockSize: Number(opts["block-size"]),
        actor,
      });
      console.log(`trial created: id=${r.id}`);
      break;
    }
    case "protocol add": {
      need(opts, "trial", "version", "effective-from", "windows");
      const r = trialSvc.addProtocolVersion(db, ctx, {
        trialId: Number(opts.trial),
        version: opts.version,
        effectiveFrom: opts["effective-from"],
        visitWindows: JSON.parse(opts.windows),
        actor,
      });
      console.log(`protocol version added: id=${r.id}`);
      break;
    }
    case "site add": {
      need(opts, "trial", "code", "name", "tz");
      const r = trialSvc.addSite(db, ctx, {
        trialId: Number(opts.trial),
        code: opts.code,
        name: opts.name,
        timezone: opts.tz,
        actor,
      });
      console.log(`site added: id=${r.id}`);
      break;
    }
    case "user add": {
      need(opts, "name", "role");
      const r = trialSvc.addUser(db, opts.name, opts.role);
      console.log(`user added: id=${r.id}`);
      break;
    }
    case "subject register": {
      need(opts, "trial", "site", "anon", "stratum");
      const r = subjectSvc.registerSubject(db, ctx, {
        trialId: Number(opts.trial),
        siteId: Number(opts.site),
        anonCode: opts.anon,
        stratum: JSON.parse(opts.stratum),
        actor,
      });
      console.log(`registered: ${subjectState(r.id)}`);
      break;
    }
    case "subject screen": {
      need(opts, "id", "eligible");
      console.log(`before: ${subjectState(Number(opts.id))}`);
      subjectSvc.recordScreening(db, ctx, {
        subjectId: Number(opts.id),
        criteria: opts.criteria ? JSON.parse(opts.criteria) : {},
        eligible: opts.eligible === "true",
        actor,
      });
      console.log(`after:  ${subjectState(Number(opts.id))}`);
      break;
    }
    case "subject consent": {
      need(opts, "id", "version");
      subjectSvc.recordConsent(db, ctx, {
        subjectId: Number(opts.id),
        consentVersion: opts.version,
        signedAt: opts["signed-at"],
        actor,
      });
      console.log(`consent recorded for ${subjectState(Number(opts.id))}`);
      break;
    }
    case "subject assign": {
      need(opts, "id");
      console.log(`before: ${subjectState(Number(opts.id))}`);
      const r = subjectSvc.assignSubject(db, ctx, { subjectId: Number(opts.id), actor });
      console.log(`assigned: seqNo=${r.seqNo} arm=${r.arm}`);
      console.log(`after:  ${subjectState(Number(opts.id))}`);
      break;
    }
    case "subject withdraw": {
      need(opts, "id", "reason");
      console.log(`before: ${subjectState(Number(opts.id))}`);
      subjectSvc.withdrawSubject(db, ctx, { subjectId: Number(opts.id), reason: opts.reason, actor });
      console.log(`after:  ${subjectState(Number(opts.id))}`);
      break;
    }
    case "visit record": {
      need(opts, "id", "name", "at");
      const r = visitSvc.recordVisit(db, ctx, {
        subjectId: Number(opts.id),
        visitName: opts.name,
        occurredAt: opts.at,
        actor,
      });
      console.log(
        `visit recorded: protocol=${r.protocolVersion} window=${r.windowStart}..${r.windowEnd} inWindow=${r.inWindow}`
      );
      break;
    }
    case "deviation report": {
      need(opts, "id", "type", "desc");
      const r = visitSvc.reportDeviation(db, ctx, {
        subjectId: Number(opts.id),
        type: opts.type,
        description: opts.desc,
        actor,
      });
      console.log(`deviation ${r.id} reported under protocol ${r.protocolVersion}`);
      break;
    }
    case "unblind": {
      need(opts, "id", "reason", "actor");
      const r = unblindSvc.unblindSubject(db, ctx, {
        subjectId: Number(opts.id),
        reason: opts.reason,
        emergency: opts.emergency === "true",
        actor,
      });
      console.log(`UNBLINDED by ${actor}: arm=${r.arm}`);
      break;
    }
    case "audit summary": {
      for (const chain of ["main", "withdrawal", "misrandomization", "unblinding"] as const) {
        const n = (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE chain = ?").get(chain) as any).c;
        console.log(`chain ${chain}: ${n} entries, intact=${verifyChain(db, chain)}`);
      }
      break;
    }
    case "status": {
      const t = (db.prepare("SELECT COUNT(*) c FROM trials").get() as any).c;
      const s = (db.prepare("SELECT COUNT(*) c FROM subjects").get() as any).c;
      const a = (db.prepare("SELECT COUNT(*) c FROM assignments").get() as any).c;
      const d = (db.prepare("SELECT COUNT(*) c FROM deviations").get() as any).c;
      console.log(`db=${dbPath} trials=${t} subjects=${s} assignments=${a} deviations=${d}`);
      break;
    }
    default:
      console.log(`ctrs CLI (fictional data only)
commands:
  trial create --code C --title T --arms A,B --block-size 4
  protocol add --trial 1 --version v1 --effective-from ISO --windows '[{"name":"V1","target_day":7,"minus_days":2,"plus_days":2}]'
  site add --trial 1 --code S1 --name "Site One" --tz Asia/Shanghai
  user add --name alice --role unblinded
  subject register --trial 1 --site 1 --anon ANON-001 --stratum '{"age":"lt65"}'
  subject screen --id 1 --eligible true [--criteria '{"inc1":true}']
  subject consent --id 1 --version ICF-v1 [--signed-at ISO]
  subject assign --id 1
  subject withdraw --id 1 --reason "withdrew consent"
  visit record --id 1 --name V1 --at ISO
  deviation report --id 1 --type OTHER --desc "..."
  unblind --id 1 --reason "..." --actor NAME [--emergency true]
  audit summary
  status`);
  }
} catch (e: any) {
  console.error(`error [${e.code ?? "INTERNAL"}]: ${e.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
