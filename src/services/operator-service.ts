import { newId } from "../domain/ids.ts";
import { ERR } from "../domain/errors.ts";
import type { AppContext } from "../app/context.ts";

export type OperatorRole = "coordinator" | "unblinded_admin" | "auditor";

export function ensureOperator(ctx: AppContext, username: string, role: OperatorRole): string {
  const existing = ctx.db.prepare("SELECT id FROM operators WHERE username = ?").get(username) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = newId();
  ctx.db.prepare("INSERT INTO operators(id, username, role) VALUES (?,?,?)").run(id, username, role);
  return id;
}

export function roleOf(ctx: AppContext, operatorId: string): OperatorRole {
  const row = ctx.db.prepare("SELECT role FROM operators WHERE id = ?").get(operatorId) as { role: OperatorRole } | undefined;
  if (!row) throw ERR.forbidden("unknown operator");
  return row.role;
}
