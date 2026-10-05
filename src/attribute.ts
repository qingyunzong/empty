import {
  mergeIntervals,
  subtractIntervals,
  totalLength,
  type Interval,
} from './intervals.js';

export interface Shift {
  id: number;
  start: number;
  end: number;
  priority: number;
}

export interface AttributedSegment {
  shiftId: number;
  start: number;
  end: number;
}

export interface ShiftTotal {
  shiftId: number;
  seconds: number;
}

export interface AttributionResult {
  segments: AttributedSegment[];
  totals: ShiftTotal[];
  totalSeconds: number;
}

export function compareShiftPrecedence(a: Shift, b: Shift): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.start !== b.start) return a.start - b.start;
  return a.id - b.id;
}

export function validateShifts(shifts: Shift[]): void {
  const seen = new Set<number>();
  for (const s of shifts) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) {
      throw new RangeError(`shift ${s.id}: endpoints must be integers`);
    }
    if (s.start >= s.end) {
      throw new RangeError(`shift ${s.id}: start must be before end`);
    }
    if (seen.has(s.id)) {
      throw new RangeError(`duplicate shift id ${s.id}`);
    }
    seen.add(s.id);
  }
}

function validateRests(rests: Interval[]): void {
  for (const r of rests) {
    if (!Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start >= r.end) {
      throw new RangeError('rest intervals must have integer endpoints with start < end');
    }
  }
}

function buildResult(segments: AttributedSegment[], shifts: Shift[]): AttributionResult {
  segments.sort((a, b) => a.start - b.start || a.shiftId - b.shiftId);
  const byId = new Map<number, number>();
  for (const seg of segments) {
    byId.set(seg.shiftId, (byId.get(seg.shiftId) ?? 0) + (seg.end - seg.start));
  }
  const totals = shifts
    .map((s) => ({ shiftId: s.id, seconds: byId.get(s.id) ?? 0 }))
    .sort((a, b) => a.shiftId - b.shiftId);
  return { segments, totals, totalSeconds: totalLength(segments) };
}

export function attributeWork(shifts: Shift[], rests: Interval[]): AttributionResult {
  validateShifts(shifts);
  validateRests(rests);
  const restCuts = mergeIntervals(rests);
  const ordered = shifts.slice().sort(compareShiftPrecedence);
  const taken: Interval[] = [];
  const segments: AttributedSegment[] = [];
  for (const shift of ordered) {
    const own = subtractIntervals([{ start: shift.start, end: shift.end }], restCuts);
    const free = subtractIntervals(own, taken);
    for (const seg of free) {
      segments.push({ shiftId: shift.id, start: seg.start, end: seg.end });
    }
    taken.push(...free);
  }
  return buildResult(segments, shifts);
}

export function attributeWorkSweep(shifts: Shift[], rests: Interval[]): AttributionResult {
  validateShifts(shifts);
  validateRests(rests);
  const points = new Set<number>();
  for (const s of shifts) {
    points.add(s.start);
    points.add(s.end);
  }
  for (const r of rests) {
    points.add(r.start);
    points.add(r.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const ordered = shifts.slice().sort(compareShiftPrecedence);
  const mergedRests = mergeIntervals(rests);
  const raw: AttributedSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start === end) continue;
    if (mergedRests.some((r) => r.start <= start && end <= r.end)) continue;
    const winner = ordered.find((s) => s.start <= start && end <= s.end);
    if (winner) raw.push({ shiftId: winner.id, start, end });
  }
  const segments: AttributedSegment[] = [];
  for (const seg of raw) {
    const last = segments[segments.length - 1];
    if (last && last.shiftId === seg.shiftId && last.end === seg.start) {
      last.end = seg.end;
    } else {
      segments.push({ ...seg });
    }
  }
  return buildResult(segments, shifts);
}
