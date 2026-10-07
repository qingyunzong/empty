import { enumerateSolutions, spaceSize } from './enumerate.js';
import type { GenResult } from './enumerate.js';
import { satisfies } from './problem.js';
import type { Assignment, Problem } from './problem.js';
import { mulberry32 } from './prng.js';

export interface RandomSampleOptions {
  /** Seed for the deterministic PRNG; same seed => same samples. */
  readonly seed: number;
  /** Number of unique samples to produce. */
  readonly count: number;
  /** Max random attempts before reporting 'budget-exhausted'. */
  readonly maxAttempts?: number;
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const rand = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/**
 * Fixed-seed random sampling.
 *
 * Short domains (search space fits in the attempt budget) are enumerated
 * exactly, so 'unsatisfiable' is decided precisely and never confused with
 * 'budget-exhausted'. Large domains use seeded rejection sampling; running
 * out of attempts reports 'budget-exhausted', never 'unsatisfiable'.
 */
export function sampleRandom(problem: Problem, options: RandomSampleOptions): GenResult {
  const { seed, count } = options;
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`count must be a positive integer, got ${count}`);
  }
  const maxAttempts = options.maxAttempts ?? Math.max(1000, count * 200);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, got ${maxAttempts}`);
  }

  if (spaceSize(problem) <= maxAttempts) {
    const all = enumerateSolutions(problem);
    if (all.samples.length === 0) {
      return { status: 'unsatisfiable', samples: [], examined: all.examined };
    }
    return {
      status: 'complete',
      samples: seededShuffle(all.samples, seed).slice(0, count),
      examined: all.examined,
    };
  }

  const rand = mulberry32(seed);
  const vars = problem.variables;
  const seen = new Set<string>();
  const samples: Assignment[] = [];
  let attempts = 0;
  while (samples.length < count && attempts < maxAttempts) {
    attempts++;
    const candidate: Record<string, number> = {};
    for (const v of vars) {
      candidate[v.name] = v.min + Math.floor(rand() * (v.max - v.min + 1));
    }
    const key = vars.map((v) => candidate[v.name]).join(',');
    if (seen.has(key)) continue;
    if (satisfies(problem, candidate)) {
      seen.add(key);
      samples.push(Object.freeze(candidate));
    }
  }
  return {
    status: samples.length >= count ? 'complete' : 'budget-exhausted',
    samples,
    examined: attempts,
  };
}
