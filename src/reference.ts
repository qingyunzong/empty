import { betterShift, HORIZON, normalizeShifts } from "./normalize";
import { Attribution, Segment } from "./types";
import { buildAttribution } from "./sweep";

export function attributeReference(shifts: Parameters<typeof normalizeShifts>[0]): Attribution {
  const norm = normalizeShifts(shifts);
  const segments: Segment[] = [];
  const totals = new Map<number, number>();
  for (let t = 0; t < HORIZON; t++) {
    let winner = -1;
    for (let k = 0; k < norm.length; k++) {
      if (!norm[k].workable[t]) continue;
      if (winner < 0 || betterShift(norm[k], norm[winner])) winner = k;
    }
    if (winner < 0) continue;
    const id = norm[winner].id;
    const last = segments[segments.length - 1];
    if (last && last.shiftId === id && last.end === t) {
      last.end = t + 1;
    } else {
      segments.push({ shiftId: id, start: t, end: t + 1 });
    }
    totals.set(id, (totals.get(id) ?? 0) + 1);
  }
  return buildAttribution(segments, totals);
}
