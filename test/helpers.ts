import { HORIZON, mergeIntervals, normalizeShifts } from "../src/normalize";
import { Interval, Shift } from "../src/types";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function randomInterval(rng: () => number): Interval {
  const start = randInt(rng, 0, HORIZON - 1);
  const end = randInt(rng, start + 1, HORIZON);
  return { start, end };
}

export interface RandomShiftOptions {
  maxShifts: number;
  withCaps: boolean;
}

export function randomShifts(rng: () => number, opts: RandomShiftOptions): Shift[] {
  const count = randInt(rng, 1, opts.maxShifts);
  const shifts: Shift[] = [];
  for (let id = 1; id <= count; id++) {
    const work: Interval[] = [];
    const workCount = randInt(rng, 1, 3);
    for (let i = 0; i < workCount; i++) work.push(randomInterval(rng));
    const rest: Interval[] = [];
    const restCount = randInt(rng, 0, 2);
    for (let i = 0; i < restCount; i++) rest.push(randomInterval(rng));
    const shift: Shift = {
      id,
      priority: randInt(rng, 0, 6),
      work,
      rest,
    };
    if (opts.withCaps) {
      shift.maxWork = randInt(rng, 0, 6);
      const span = mergeIntervals(work).reduce((n, iv) => n + (iv.end - iv.start), 0);
      shift.minRest = randInt(rng, 0, Math.min(3, span));
    }
    shifts.push(shift);
  }
  return shifts;
}

export function greedyAllocate(shifts: Shift[]): { coverage: number; benefit: number } {
  const norm = normalizeShifts(shifts);
  const capsLeft = norm.map((s) => s.cap);
  let coverage = 0;
  let benefit = 0;
  for (let t = 0; t < HORIZON; t++) {
    let best = -1;
    for (let k = 0; k < norm.length; k++) {
      if (!norm[k].workable[t] || capsLeft[k] <= 0) continue;
      if (best < 0) {
        best = k;
        continue;
      }
      const a = norm[k];
      const b = norm[best];
      if (
        a.priority > b.priority ||
        (a.priority === b.priority && a.start < b.start) ||
        (a.priority === b.priority && a.start === b.start && a.id < b.id)
      ) {
        best = k;
      }
    }
    if (best >= 0) {
      capsLeft[best]--;
      coverage++;
      benefit += norm[best].priority;
    }
  }
  return { coverage, benefit };
}
