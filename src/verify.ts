import { HORIZON, normalizeShifts } from "./normalize";
import { Allocation, Shift } from "./types";

export function verifyAllocation(shifts: Shift[], alloc: Allocation): string[] {
  const problems: string[] = [];
  const norm = normalizeShifts(shifts);
  const byId = new Map(norm.map((s, k) => [s.id, k]));
  const owner = new Array<number>(HORIZON).fill(-1);
  const assignedPerShift = new Array<number>(norm.length).fill(0);

  for (const seg of alloc.segments) {
    const k = byId.get(seg.shiftId);
    if (k === undefined) {
      problems.push(`segment references unknown shift ${seg.shiftId}`);
      continue;
    }
    if (!(0 <= seg.start && seg.start < seg.end && seg.end <= HORIZON)) {
      problems.push(`segment ${seg.shiftId} [${seg.start},${seg.end}) out of range`);
      continue;
    }
    for (let t = seg.start; t < seg.end; t++) {
      if (!norm[k].workable[t]) {
        problems.push(`slot ${t} assigned to shift ${seg.shiftId} but not workable`);
      }
      if (owner[t] !== -1) {
        problems.push(`slot ${t} assigned to more than one shift`);
      }
      owner[t] = k;
      assignedPerShift[k]++;
    }
  }

  let coverage = 0;
  let benefit = 0;
  for (let t = 0; t < HORIZON; t++) {
    if (owner[t] >= 0) {
      coverage++;
      benefit += norm[owner[t]].priority;
    }
  }
  if (coverage !== alloc.coverage) {
    problems.push(`reported coverage ${alloc.coverage} != actual ${coverage}`);
  }
  if (benefit !== alloc.benefit) {
    problems.push(`reported benefit ${alloc.benefit} != actual ${benefit}`);
  }

  for (let k = 0; k < norm.length; k++) {
    const s = norm[k];
    const assigned = assignedPerShift[k];
    if (assigned > s.cap) {
      problems.push(`shift ${s.id} assigned ${assigned} exceeds cap ${s.cap}`);
    }
    if (assigned > s.maxWork) {
      problems.push(`shift ${s.id} assigned ${assigned} exceeds maxWork ${s.maxWork}`);
    }
    const restSeconds = s.explicitRestCount + (s.workableCount - assigned);
    if (restSeconds < s.minRest) {
      problems.push(`shift ${s.id} rest ${restSeconds} below minRest ${s.minRest}`);
    }
    const reported = alloc.totals.get(s.id) ?? 0;
    if (reported !== assigned) {
      problems.push(`shift ${s.id} totals ${reported} != assigned ${assigned}`);
    }
  }

  for (const cert of alloc.certificates) {
    const k = byId.get(cert.shiftId);
    if (k === undefined) {
      problems.push(`certificate references unknown shift ${cert.shiftId}`);
      continue;
    }
    const s = norm[k];
    const restSeconds = s.explicitRestCount + (s.workableCount - assignedPerShift[k]);
    if (cert.restSeconds !== restSeconds) {
      problems.push(`shift ${s.id} certificate rest ${cert.restSeconds} != ${restSeconds}`);
    }
    if (cert.minRest !== s.minRest) {
      problems.push(`shift ${s.id} certificate minRest mismatch`);
    }
    if (cert.ok !== restSeconds >= s.minRest) {
      problems.push(`shift ${s.id} certificate ok flag wrong`);
    }
  }
  return problems;
}
