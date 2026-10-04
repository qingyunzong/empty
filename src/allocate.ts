import { MinCostMaxFlow } from "./flow";
import { HORIZON, normalizeShifts } from "./normalize";
import { Allocation, Interval, RestCertificate, Segment, Shift } from "./types";

function slotsToIntervals(slots: boolean[]): Interval[] {
  const out: Interval[] = [];
  let t = 0;
  while (t < slots.length) {
    if (!slots[t]) {
      t++;
      continue;
    }
    let u = t;
    while (u < slots.length && slots[u]) u++;
    out.push({ start: t, end: u });
    t = u;
  }
  return out;
}

export function allocate(shifts: Shift[]): Allocation {
  const norm = normalizeShifts(shifts);
  const slotCount = HORIZON;
  const source = 0;
  const slotBase = 1;
  const shiftBase = slotBase + slotCount;
  const sink = shiftBase + norm.length;
  const mcf = new MinCostMaxFlow(sink + 1);

  const maxPriority = norm.reduce((m, s) => Math.max(m, s.priority), 0);
  for (let t = 0; t < slotCount; t++) {
    mcf.addEdge(source, slotBase + t, 1, 0);
  }
  const arcIndex: number[][] = norm.map(() => new Array<number>(slotCount).fill(-1));
  for (let k = 0; k < norm.length; k++) {
    for (let t = 0; t < slotCount; t++) {
      if (!norm[k].workable[t]) continue;
      arcIndex[k][t] = mcf.addEdge(slotBase + t, shiftBase + k, 1, maxPriority - norm[k].priority);
    }
  }
  for (let k = 0; k < norm.length; k++) {
    mcf.addEdge(shiftBase + k, sink, norm[k].cap, 0);
  }

  mcf.run(source, sink);

  const assignedShift: number[] = new Array<number>(slotCount).fill(-1);
  for (let k = 0; k < norm.length; k++) {
    for (let t = 0; t < slotCount; t++) {
      const arc = arcIndex[k][t];
      if (arc >= 0 && mcf.residualCap(slotBase + t, arc) === 0) assignedShift[t] = k;
    }
  }

  const segments: Segment[] = [];
  const totals = new Map<number, number>();
  let coverage = 0;
  let benefit = 0;
  const assignedPerShift = new Array<number>(norm.length).fill(0);
  for (let k = 0; k < norm.length; k++) {
    const mine = new Array<boolean>(slotCount).fill(false);
    for (let t = 0; t < slotCount; t++) {
      if (assignedShift[t] === k) mine[t] = true;
    }
    for (const iv of slotsToIntervals(mine)) {
      segments.push({ shiftId: norm[k].id, start: iv.start, end: iv.end });
    }
  }
  segments.sort((a, b) => a.start - b.start || a.shiftId - b.shiftId);
  for (let t = 0; t < slotCount; t++) {
    const k = assignedShift[t];
    if (k < 0) continue;
    coverage++;
    benefit += norm[k].priority;
    assignedPerShift[k]++;
    totals.set(norm[k].id, (totals.get(norm[k].id) ?? 0) + 1);
  }

  const certificates: RestCertificate[] = norm.map((s, k) => {
    const unassigned = new Array<boolean>(slotCount).fill(false);
    for (let t = 0; t < slotCount; t++) {
      if (s.workable[t] && assignedShift[t] !== k) unassigned[t] = true;
    }
    const unassignedRest = slotsToIntervals(unassigned);
    const unassignedCount = s.workableCount - assignedPerShift[k];
    const restSeconds = s.explicitRestCount + unassignedCount;
    return {
      shiftId: s.id,
      explicitRest: s.rest.map((iv) => ({ ...iv })),
      unassignedRest,
      restSeconds,
      minRest: s.minRest,
      ok: restSeconds >= s.minRest,
    };
  });

  return { segments, totals, coverage, benefit, certificates };
}
