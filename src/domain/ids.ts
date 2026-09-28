import { randomUUID, createHash } from "node:crypto";

export const newId = (): string => randomUUID();

export function stratumSignature(values: Record<string, string>): string {
  const keys = Object.keys(values).sort();
  return keys.map((k) => `${k}=${values[k]}`).join("|");
}

export function anonCode(siteCode: string, sequential: number): string {
  const suffix = createHash("sha1").update(`${siteCode}:${sequential}`).digest("hex").slice(0, 8).toUpperCase();
  return `${siteCode}-${String(sequential).padStart(4, "0")}-${suffix}`;
}
