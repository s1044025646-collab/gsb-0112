import type { DatabaseSync } from "node:sqlite";
import { openDatabase, migrate } from "../db/database.ts";
import type { ClockProvider } from "../services/trial-service.ts";

export interface AppContext {
  db: DatabaseSync;
  clock: ClockProvider;
  operatorId?: string;
}

export interface CreateAppOptions {
  filename: string;
  clock?: ClockProvider;
}

export function createAppContext(opts: CreateAppOptions): AppContext {
  const db = openDatabase(opts.filename);
  migrate(db, () => (opts.clock ? opts.clock.now() : new Date()));
  return { db, clock: opts.clock ?? { now: () => new Date() } };
}

export function closeAppContext(ctx: AppContext): void {
  ctx.db.close();
}
