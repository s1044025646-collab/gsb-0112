import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const entry = join(process.cwd(), "src/cli/main.ts");

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fict-cli-"));
  dbFile = join(dir, "cli.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(...args: string[]) {
  const result = await exec(process.execPath, ["--import", "tsx", entry, ...args], {
    env: { ...process.env, TRIAL_DB: dbFile },
    cwd: process.cwd(),
    maxBuffer: 10_000_000,
  });
  return { ...result, stdout: result.stdout.replace(/\(node:.*\r?\n?/g, "").replace(/\(Use `node --trace-warnings.*\r?\n?/g, "") };
}

function subjectIdFrom(stdout: string): string {
  const m = /"subjectId":\s*"([^"]+)"/.exec(stdout);
  if (!m) throw new Error(`no subjectId in output: ${stdout}`);
  return m[1]!;
}

describe("CLI end to end across process restarts", () => {
  it("runs init -> seed -> screen -> allocate -> audit with distinct processes", async () => {
    const init = await cli("init-db");
    expect(init.stdout).toContain("migrations");

    const secondInit = await cli("init-db");
    expect(secondInit.stdout).toContain("version");

    const seed = await cli("seed-fixtures");
    expect(seed.stdout).toContain("FICT-042");

    const screen = await cli("screen",
      "--trial", "FICT-042", "--site", "BJ01",
      "--strata-json", '{"age_band":"<65","disease_stage":"II"}',
      "--criteria-json", '{"inclusion_age":true,"inclusion_diagnosis":true,"exclusion_pregnancy":true}',
      "--consent-at", "2026-01-04T08:00:00Z",
      "--operator", "fic-coord");
    const subjectId = subjectIdFrom(screen.stdout);
    expect(screen.stdout).toContain('"eligible": true');

    const allocate = await cli("allocate", "--subject-id", subjectId, "--operator", "fic-coord");
    expect(allocate.stdout).toContain('"status": "active"');
    expect(allocate.stdout).not.toContain('"arm"');

    const status = await cli("status", "--subject-id", subjectId, "--operator", "fic-coord");
    expect(status.stdout).toContain('"enrolled"');

    const unblind = await cli("unblind", "--subject-id", subjectId,
      "--reason", "emergency", "--justification", "fictional emergency drill",
      "--operator", "fic-admin");
    expect(unblind.stdout).toMatch(/"arm": "[AB]"/);

    const audit = await cli("audit-summary");
    expect(audit.stdout).toContain('"ok": true');
    expect(audit.stdout).toContain("emergency drill");
  });

  it("refuses allocation after withdrawal in a later process", async () => {
    await cli("seed-fixtures");
    const screen = await cli("screen",
      "--trial", "FICT-042", "--site", "SH01",
      "--strata-json", '{"age_band":">=65","disease_stage":"III"}',
      "--criteria-json", '{"inclusion_age":true}',
      "--consent-at", "2026-01-04T08:00:00Z",
      "--operator", "fic-coord");
    const subjectId = subjectIdFrom(screen.stdout);

    await expect(cli("withdraw", "--subject-id", subjectId, "--operator", "fic-coord")).resolves.toBeDefined();
    await expect(cli("allocate", "--subject-id", subjectId, "--operator", "fic-coord")).rejects.toMatchObject({
      message: expect.stringMatching(/FORBIDDEN|SUBJECT_NOT_ALLOCATABLE/),
    });
  });

  it("records a visit deviation via CLI", async () => {
    await cli("seed-fixtures");
    const screen = await cli("screen",
      "--trial", "FICT-042", "--site", "WQ01",
      "--strata-json", '{"age_band":"<65","disease_stage":"II"}',
      "--criteria-json", '{"inclusion_age":true}',
      "--consent-at", "2026-01-04T08:00:00Z",
      "--operator", "fic-coord");
    const subjectId = subjectIdFrom(screen.stdout);
    await cli("allocate", "--subject-id", subjectId, "--operator", "fic-coord");
    await cli("visit-schedule", "--subject-id", subjectId, "--visit", "V2_WEEK4",
      "--baseline-at", new Date(Date.now() + 2 * 86_400_000).toISOString(), "--operator", "fic-coord");
    const recorded = await cli("visit-record", "--subject-id", subjectId, "--visit", "V2_WEEK4",
      "--occurred-at", new Date(Date.now() + 12 * 86_400_000).toISOString(), "--operator", "fic-coord");
    expect(recorded.stdout).toContain("visit_out_of_window_early");
  });

  it("shows help and nonzero exit on bad input", async () => {
    const help = await cli("help");
    expect(help.stdout).toContain("Commands:");
    await expect(cli("screen", "--trial", "NOPE")).rejects.toMatchObject({ code: 1 });
  });
});
