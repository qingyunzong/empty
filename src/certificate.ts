import type { Instance } from "./types.js";

export interface SkillCountRow {
  skill: string;
  count: number;
  required: number;
  ok: boolean;
}

export interface ForbiddenPairRow {
  a: string;
  b: string;
  aIn: boolean;
  bIn: boolean;
  ok: boolean;
}

export interface Certificate {
  skills: SkillCountRow[];
  forbiddenPairs: ForbiddenPairRow[];
  ok: boolean;
}

// Independently re-checks a proposed team against every constraint so the
// output can be verified without trusting the solver.
export function buildCertificate(instance: Instance, indices: number[]): Certificate {
  const inTeam = new Set(indices);
  const counts = instance.skills.map(() => 0);
  for (const i of indices) {
    const mask = instance.people[i]!.skillMask;
    for (let k = 0; k < instance.skills.length; k++) counts[k]! += (mask >> k) & 1;
  }
  const skills: SkillCountRow[] = instance.skills.map((skill, k) => ({
    skill,
    count: counts[k]!,
    required: instance.required[k]!,
    ok: counts[k]! >= instance.required[k]!,
  }));
  const forbiddenPairs: ForbiddenPairRow[] = instance.forbiddenPairs.map(([ia, ib]) => {
    const aIn = inTeam.has(ia);
    const bIn = inTeam.has(ib);
    return {
      a: instance.people[ia]!.id,
      b: instance.people[ib]!.id,
      aIn,
      bIn,
      ok: !(aIn && bIn),
    };
  });
  const ok = skills.every((row) => row.ok) && forbiddenPairs.every((row) => row.ok);
  return { skills, forbiddenPairs, ok };
}
