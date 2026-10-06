import type { PermissionOp } from '../src/op.js';

/** Deterministic seeded PRNG (mulberry32) so randomized checks are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle driven by the given PRNG. */
export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Normalize an effective() result into a comparable plain object. */
export function normalized(entries: ReadonlyArray<{
  perm: string;
  granted: boolean;
  sources: ReadonlyArray<{ opId: string }>;
  revokedBy: ReadonlyArray<{ opId: string }>;
}>): Record<string, { granted: boolean; sources: string[]; revokedBy: string[] }> {
  const out: Record<string, { granted: boolean; sources: string[]; revokedBy: string[] }> = {};
  for (const e of entries) {
    out[e.perm] = {
      granted: e.granted,
      sources: e.sources.map((s) => s.opId),
      revokedBy: e.revokedBy.map((s) => s.opId),
    };
  }
  return out;
}

export type { PermissionOp };
