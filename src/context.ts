/** Injectable clock & randomness so tests never wait on real time. */
export interface Ctx {
  now: () => Date;
  randomBytes: (n: number) => Buffer;
}

import { randomBytes as nodeRandomBytes } from "node:crypto";

export const systemCtx: Ctx = {
  now: () => new Date(),
  randomBytes: (n: number) => nodeRandomBytes(n),
};

/** Deterministic context for tests/fixtures. */
export function fixedCtx(startIso: string, seedByte = 0xab): Ctx {
  let t = Date.parse(startIso);
  let counter = 0;
  return {
    now: () => new Date(t),
    randomBytes: (n: number) => {
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i++) buf[i] = (seedByte + counter * 31 + i) & 0xff;
      counter++;
      return buf;
    },
  };
}

/** Advance helper returned separately so tests control time explicitly. */
export function mutableClock(startIso: string): { ctx: Ctx; set: (iso: string) => void; advanceMs: (ms: number) => void } {
  let t = Date.parse(startIso);
  return {
    ctx: { now: () => new Date(t), randomBytes: systemCtx.randomBytes },
    set: (iso: string) => { t = Date.parse(iso); },
    advanceMs: (ms: number) => { t += ms; },
  };
}
