import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAppContext, closeAppContext, type AppContext } from "../src/app/context.ts";
import { installFictionalTrial, type FixtureHandle } from "../src/fixtures/fictional-trial.ts";

export class MutableClock {
  private current: Date;
  constructor(start = new Date("2026-01-05T08:00:00Z")) {
    this.current = start;
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(d: Date): void {
    this.current = d;
  }
  addDays(n: number): Date {
    this.current = new Date(this.current.getTime() + n * 86_400_000);
    return this.now();
  }
}

export interface Harness {
  ctx: AppContext;
  fixture: FixtureHandle;
  clock: MutableClock;
  dir: string;
  reopen(): Harness;
  close(): void;
}

export function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "fict-trial-"));
  const dbFile = join(dir, "data.db");
  const clock = new MutableClock();
  const build = (): { ctx: AppContext; fixture?: FixtureHandle } => {
    const ctx = createAppContext({ filename: dbFile, clock });
    const count = (ctx.db.prepare("SELECT COUNT(*) AS c FROM trials").get() as { c: number }).c;
    const fixture = count === 0 ? installFictionalTrial(ctx) : undefined;
    return { ctx, fixture: fixture ?? ({} as FixtureHandle) };
  };
  const first = build();
  const fixture = first.fixture!;

  const harness: Harness = {
    ctx: first.ctx, fixture, clock, dir,
    reopen(): Harness {
      closeAppContext(this.ctx);
      const next = createAppContext({ filename: dbFile, clock });
      this.ctx = next;
      const count = (next.db.prepare("SELECT COUNT(*) AS c FROM trials").get() as { c: number }).c;
      if (count === 0) throw new Error("data did not persist across reopen");
      return this;
    },
    close(): void {
      closeAppContext(this.ctx);
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}
