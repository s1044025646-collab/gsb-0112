import { createHash } from "node:crypto";

export interface RandomSource {
  next(): number;
}

export class SeededRng implements RandomSource {
  private state: bigint;

  constructor(seed: string) {
    const digest = createHash("sha256").update(seed).digest();
    this.state = BigInt("0x" + digest.subarray(0, 16).toString("hex")) | 1n;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13n;
    x ^= x >> 7n;
    x ^= x << 17n;
    this.state = BigInt.asUintN(64, x);
    return Number(this.state % 1_000_000n) / 1_000_000;
  }
}

export function shuffled<T>(items: T[], rng: RandomSource): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
