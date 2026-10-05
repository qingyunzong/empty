import type { Candidate, Instance } from "./types.js";
import { compareCandidates } from "./solve.js";

export interface EnumerationResult {
  best: Candidate | null;
  totalTeams: number;
  feasibleTeams: number;
}

// Exhaustive enumeration of every subset, used to cross-check the
// branch-and-bound solver on small instances.
export function enumerateAll(instance: Instance): EnumerationResult {
  const n = instance.people.length;
  if (n > 26) throw new Error(`exhaustive enumeration limited to 26 people, got ${n}`);
  const skillCount = instance.skills.length;
  const required = instance.required;
  const total = 1 << n;
  const counts = new Array<number>(skillCount);
  let best: Candidate | null = null;
  let feasibleTeams = 0;

  for (let mask = 0; mask < total; mask++) {
    let rest = mask;
    let valid = true;
    let cost = 0;
    let size = 0;
    counts.fill(0);
    while (rest !== 0) {
      const bit = rest & -rest;
      const i = 31 - Math.clz32(bit);
      rest ^= bit;
      if ((instance.forbiddenMask[i]! & mask) !== 0) {
        valid = false;
        break;
      }
      const person = instance.people[i]!;
      cost += person.cost;
      size++;
      for (let k = 0; k < skillCount; k++) counts[k]! += (person.skillMask >> k) & 1;
    }
    if (!valid) continue;
    let feasible = true;
    for (let k = 0; k < skillCount; k++) {
      if (counts[k]! < required[k]!) {
        feasible = false;
        break;
      }
    }
    if (!feasible) continue;
    feasibleTeams++;
    const indices: number[] = [];
    for (let i = 0; i < n; i++) if ((mask >> i) & 1) indices.push(i);
    const candidate: Candidate = {
      cost,
      size,
      ids: indices.map((i) => instance.people[i]!.id).sort(),
      indices,
    };
    if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
  }
  return { best, totalTeams: total, feasibleTeams };
}
