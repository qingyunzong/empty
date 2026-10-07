import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Rational } from "./rational.ts";
import { gcd, toString as ratToString } from "./rational.ts";

export interface Sample {
  readonly id: string;
  readonly diff: Rational;
}

export const MAX_SAMPLES = 20;
export const STATISTIC_ID = "abs_mean_paired_difference";
export const TAIL_ID = "two_sided_ge_observed";

export function validateSamples(samples: readonly Sample[]): void {
  if (samples.length === 0) throw new Error("dataset must contain at least one sample");
  if (samples.length > MAX_SAMPLES) {
    throw new Error(`at most ${MAX_SAMPLES} samples supported, got ${samples.length}`);
  }
  const seen = new Set<string>();
  for (const s of samples) {
    if (seen.has(s.id)) throw new Error(`duplicate sample id: ${s.id}`);
    seen.add(s.id);
  }
}

export function datasetHash(samples: readonly Sample[]): string {
  const canon = samples
    .map((s) => ({ id: s.id, diff: ratToString(s.diff) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify({ statistic: STATISTIC_ID, tail: TAIL_ID, samples: canon }))
    .digest("hex");
}

function lcm(a: bigint, b: bigint): bigint {
  if (a === 0n || b === 0n) return 0n;
  return (a / gcd(a, b)) * b;
}

export interface ScaledData {
  readonly scale: bigint;
  readonly signedScaled: readonly bigint[];
  readonly absNonzero: readonly bigint[];
  readonly zeroCount: number;
  readonly observedSumScaled: bigint;
}

export function scaleSamples(samples: readonly Sample[]): ScaledData {
  let scale = 1n;
  for (const s of samples) scale = lcm(scale, s.diff.den);
  const signedScaled = samples.map((s) => s.diff.num * (scale / s.diff.den));
  const absNonzero: bigint[] = [];
  for (const v of signedScaled) {
    if (v !== 0n) absNonzero.push(v < 0n ? -v : v);
  }
  let observed = 0n;
  for (const v of signedScaled) observed += v;
  return {
    scale,
    signedScaled,
    absNonzero,
    zeroCount: signedScaled.length - absNonzero.length,
    observedSumScaled: observed,
  };
}

export interface EnumResult {
  readonly tailCount: bigint;
  readonly totalAssignments: bigint;
  readonly done: boolean;
  readonly processed: bigint;
}

export interface EnumOptions {
  readonly checkpointFile?: string;
  readonly checkpointEvery?: number;
  readonly maxSteps?: number;
  readonly resume?: boolean;
}

function binom(n: number, k: number): bigint {
  if (k < 0 || k > n) return 0n;
  let r = 1n;
  for (let i = 0; i < k; i++) {
    r = (r * BigInt(n - i)) / BigInt(i + 1);
  }
  return r;
}

interface CompressedState {
  engine: "compressed";
  datasetHash: string;
  nextGroup: number;
  totalGroups: number;
  counts: [string, string][];
}

export function groupMultiplicities(samples: readonly Sample[]): Map<string, number> {
  const data = scaleSamples(samples);
  const groups = new Map<bigint, number>();
  for (const a of data.absNonzero) groups.set(a, (groups.get(a) ?? 0) + 1);
  const out = new Map<string, number>();
  const sorted = [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  for (const [scaledAbs, m] of sorted) {
    const key = ratToString({ num: scaledAbs, den: data.scale });
    out.set(key, (out.get(key) ?? 0) + m);
  }
  return out;
}

export function enumerateCompressed(
  samples: readonly Sample[],
  opts: EnumOptions = {},
): EnumResult & { counts: Map<bigint, bigint> } {
  validateSamples(samples);
  const data = scaleSamples(samples);
  const threshold = data.observedSumScaled < 0n ? -data.observedSumScaled : data.observedSumScaled;
  const groups = new Map<bigint, number>();
  for (const a of data.absNonzero) groups.set(a, (groups.get(a) ?? 0) + 1);
  const groupList = [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));

  let counts = new Map<bigint, bigint>([[0n, 1n]]);
  let startGroup = 0;
  const hash = datasetHash(samples);

  if (opts.resume && opts.checkpointFile && existsSync(opts.checkpointFile)) {
    const state = JSON.parse(readFileSync(opts.checkpointFile, "utf8")) as CompressedState;
    if (state.engine !== "compressed" || state.datasetHash !== hash) {
      throw new Error("checkpoint does not match dataset/engine");
    }
    counts = new Map(state.counts.map(([k, v]) => [BigInt(k), BigInt(v)]));
    startGroup = state.nextGroup;
  }

  const every = opts.checkpointEvery ?? 1;
  for (let gi = startGroup; gi < groupList.length; gi++) {
    const [value, m] = groupList[gi];
    const next = new Map<bigint, bigint>();
    for (const [sum, c] of counts) {
      for (let k = 0; k <= m; k++) {
        const contrib = BigInt(2 * k - m) * value;
        const ways = binom(m, k);
        const key = sum + contrib;
        next.set(key, (next.get(key) ?? 0n) + c * ways);
      }
    }
    counts = next;
    if (opts.checkpointFile && (gi + 1) % every === 0) {
      const state: CompressedState = {
        engine: "compressed",
        datasetHash: hash,
        nextGroup: gi + 1,
        totalGroups: groupList.length,
        counts: [...counts].map(([k, v]) => [k.toString(), v.toString()]),
      };
      writeFileSync(opts.checkpointFile, JSON.stringify(state, null, 2));
    }
  }

  let tail = 0n;
  let total = 0n;
  for (const [sum, c] of counts) {
    total += c;
    if (sum >= threshold || sum <= -threshold) tail += c;
  }
  return { tailCount: tail, totalAssignments: total, done: true, processed: total, counts };
}

interface NaiveState {
  engine: "naive";
  datasetHash: string;
  nextIndex: string;
  tailCount: string;
  totalAssignments: string;
}

export function enumerateNaive(samples: readonly Sample[], opts: EnumOptions = {}): EnumResult {
  validateSamples(samples);
  const data = scaleSamples(samples);
  const values = data.absNonzero;
  const m = values.length;
  const total = 1n << BigInt(m);
  const threshold = data.observedSumScaled < 0n ? -data.observedSumScaled : data.observedSumScaled;
  const hash = datasetHash(samples);

  let idx = 0n;
  let tail = 0n;
  if (opts.resume && opts.checkpointFile && existsSync(opts.checkpointFile)) {
    const state = JSON.parse(readFileSync(opts.checkpointFile, "utf8")) as NaiveState;
    if (state.engine !== "naive" || state.datasetHash !== hash) {
      throw new Error("checkpoint does not match dataset/engine");
    }
    if (state.totalAssignments !== total.toString()) {
      throw new Error("checkpoint total mismatch");
    }
    idx = BigInt(state.nextIndex);
    tail = BigInt(state.tailCount);
  }

  let sum = 0n;
  for (let j = 0; j < m; j++) {
    sum += ((idx >> BigInt(j)) & 1n) === 1n ? values[j] : -values[j];
  }

  const every = opts.checkpointEvery ?? 65536;
  let sinceCheckpoint = 0;
  let steps = 0;

  const save = (nextIndex: bigint): void => {
    if (!opts.checkpointFile) return;
    const state: NaiveState = {
      engine: "naive",
      datasetHash: hash,
      nextIndex: nextIndex.toString(),
      tailCount: tail.toString(),
      totalAssignments: total.toString(),
    };
    writeFileSync(opts.checkpointFile, JSON.stringify(state, null, 2));
  };

  while (idx < total) {
    if (sum >= threshold || sum <= -threshold) tail++;
    idx++;
    steps++;
    sinceCheckpoint++;
    if (idx < total) {
      let changed = idx ^ (idx - 1n);
      let j = 0;
      while (changed !== 0n) {
        if ((changed & 1n) === 1n) {
          sum += ((idx >> BigInt(j)) & 1n) === 1n ? 2n * values[j] : -2n * values[j];
        }
        changed >>= 1n;
        j++;
      }
    }
    if (opts.maxSteps !== undefined && steps >= opts.maxSteps) break;
    if (sinceCheckpoint >= every) {
      save(idx);
      sinceCheckpoint = 0;
    }
  }
  save(idx);
  return { tailCount: tail, totalAssignments: total, done: idx >= total, processed: idx };
}
