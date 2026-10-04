import { Interval, Shift } from "./types";

export const HORIZON = 30;
export const MAX_SHIFTS = 12;

export interface NormalizedShift {
  id: number;
  priority: number;
  start: number;
  work: Interval[];
  rest: Interval[];
  workable: boolean[];
  workableCount: number;
  explicitRestCount: number;
  maxWork: number;
  minRest: number;
  cap: number;
}

function checkInterval(iv: Interval, what: string): void {
  if (!Number.isInteger(iv.start) || !Number.isInteger(iv.end)) {
    throw new Error(`${what} endpoints must be integers`);
  }
  if (iv.start < 0 || iv.end > HORIZON || iv.start >= iv.end) {
    throw new Error(`${what} must satisfy 0 <= start < end <= ${HORIZON}`);
  }
}

export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .map((iv) => ({ start: iv.start, end: iv.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

function clipToWork(rest: Interval[], work: Interval[]): Interval[] {
  const clipped: Interval[] = [];
  for (const r of rest) {
    for (const w of work) {
      const start = Math.max(r.start, w.start);
      const end = Math.min(r.end, w.end);
      if (start < end) clipped.push({ start, end });
    }
  }
  return mergeIntervals(clipped);
}

export function normalizeShifts(shifts: Shift[]): NormalizedShift[] {
  if (shifts.length > MAX_SHIFTS) {
    throw new Error(`at most ${MAX_SHIFTS} shifts are supported`);
  }
  const seen = new Set<number>();
  return shifts.map((s) => {
    if (seen.has(s.id)) throw new Error(`duplicate shift id ${s.id}`);
    seen.add(s.id);
    if (!Number.isInteger(s.id)) throw new Error("shift id must be an integer");
    if (!Number.isFinite(s.priority)) throw new Error("priority must be finite");

    for (const iv of s.work) checkInterval(iv, "work interval");
    const work = mergeIntervals(s.work);
    for (const iv of s.rest ?? []) checkInterval(iv, "rest interval");
    const rest = clipToWork(s.rest ?? [], work);

    const workable = new Array<boolean>(HORIZON).fill(false);
    for (const iv of work) {
      for (let t = iv.start; t < iv.end; t++) workable[t] = true;
    }
    let explicitRestCount = 0;
    for (const iv of rest) {
      for (let t = iv.start; t < iv.end; t++) {
        if (workable[t]) {
          workable[t] = false;
          explicitRestCount++;
        }
      }
    }
    const workableCount = workable.reduce((n, w) => n + (w ? 1 : 0), 0);

    const maxWork = s.maxWork ?? HORIZON;
    const minRest = s.minRest ?? 0;
    if (!Number.isInteger(maxWork) || maxWork < 0) {
      throw new Error("maxWork must be a non-negative integer");
    }
    if (!Number.isInteger(minRest) || minRest < 0) {
      throw new Error("minRest must be a non-negative integer");
    }
    const cap = Math.max(
      0,
      Math.min(maxWork, workableCount - Math.max(0, minRest - explicitRestCount)),
    );
    return {
      id: s.id,
      priority: s.priority,
      start: work.length > 0 ? work[0].start : HORIZON + 1,
      work,
      rest,
      workable,
      workableCount,
      explicitRestCount,
      maxWork,
      minRest,
      cap,
    };
  });
}

export function betterShift(a: NormalizedShift, b: NormalizedShift): boolean {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.start !== b.start) return a.start < b.start;
  return a.id < b.id;
}
