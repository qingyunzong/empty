import { betterShift, normalizeShifts } from "./normalize";
import { Attribution, Segment } from "./types";

function pushSegment(segments: Segment[], shiftId: number, start: number, end: number): void {
  const last = segments[segments.length - 1];
  if (last && last.shiftId === shiftId && last.end === start) {
    last.end = end;
  } else {
    segments.push({ shiftId, start, end });
  }
}

export function buildAttribution(
  segments: Segment[],
  totals: Map<number, number>,
): Attribution {
  let totalSeconds = 0;
  for (const seconds of totals.values()) totalSeconds += seconds;
  return { segments, totals, totalSeconds };
}

export function attributeSweep(shifts: Parameters<typeof normalizeShifts>[0]): Attribution {
  const norm = normalizeShifts(shifts);
  const points = new Set<number>();
  for (const s of norm) {
    for (const iv of s.work) {
      points.add(iv.start);
      points.add(iv.end);
    }
    for (const iv of s.rest) {
      points.add(iv.start);
      points.add(iv.end);
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const segments: Segment[] = [];
  const totals = new Map<number, number>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    let winner = -1;
    for (let k = 0; k < norm.length; k++) {
      if (!norm[k].workable[a]) continue;
      if (winner < 0 || betterShift(norm[k], norm[winner])) winner = k;
    }
    if (winner < 0) continue;
    const id = norm[winner].id;
    pushSegment(segments, id, a, b);
    totals.set(id, (totals.get(id) ?? 0) + (b - a));
  }
  return buildAttribution(segments, totals);
}
