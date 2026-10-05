import { InputError, Problem } from "./model";

export interface SkillCheck {
  skill: string;
  required: number;
  actual: number;
  ok: boolean;
}

export interface ForbiddenPairCheck {
  pair: [string, string];
  /** Which of the two members are in the team (never both when ok). */
  membersInTeam: string[];
  ok: boolean;
}

export interface Certificate {
  team: string[];
  size: number;
  cost: number;
  skillCounts: Record<string, number>;
  skillChecks: SkillCheck[];
  forbiddenPairChecks: ForbiddenPairCheck[];
  /** True when every skill minimum and every forbidden-pair constraint holds. */
  verified: boolean;
}

/**
 * Build a self-checking certificate for a team: per-skill headcounts against
 * the required minimums, and a per-pair forbidden-pair audit.
 */
export function buildCertificate(problem: Problem, team: string[]): Certificate {
  const indexById = new Map<string, number>();
  problem.ids.forEach((id, i) => indexById.set(id, i));

  const teamSet = new Set<string>();
  const skillCounts: Record<string, number> = {};
  for (const skill of problem.skills) {
    skillCounts[skill] = 0;
  }
  let cost = 0;
  for (const id of team) {
    const i = indexById.get(id);
    if (i === undefined) {
      throw new InputError(`certificate: unknown team member "${id}"`);
    }
    if (teamSet.has(id)) {
      throw new InputError(`certificate: duplicate team member "${id}"`);
    }
    teamSet.add(id);
    cost += problem.costs[i];
    const mask = problem.personSkillMask[i];
    for (let t = 0; t < problem.skills.length; t++) {
      if ((mask >> t) & 1) {
        skillCounts[problem.skills[t]]++;
      }
    }
  }

  const skillChecks: SkillCheck[] = problem.skills.map((skill, t) => ({
    skill,
    required: problem.required[t],
    actual: skillCounts[skill],
    ok: skillCounts[skill] >= problem.required[t],
  }));

  const forbiddenPairChecks: ForbiddenPairCheck[] = problem.forbiddenPairs.map(([a, b]) => {
    const membersInTeam = [a, b].filter((id) => teamSet.has(id));
    return { pair: [a, b] as [string, string], membersInTeam, ok: membersInTeam.length < 2 };
  });

  const verified =
    skillChecks.every((check) => check.ok) && forbiddenPairChecks.every((check) => check.ok);

  const sortedTeam = [...team].sort();
  return {
    team: sortedTeam,
    size: sortedTeam.length,
    cost,
    skillCounts,
    skillChecks,
    forbiddenPairChecks,
    verified,
  };
}

/**
 * Independently recompute the certificate for cert.team and confirm it
 * matches the claimed contents and is fully verified.
 */
export function verifyCertificate(problem: Problem, cert: Certificate): boolean {
  let rebuilt: Certificate;
  try {
    rebuilt = buildCertificate(problem, cert.team);
  } catch {
    return false;
  }
  return (
    rebuilt.verified &&
    cert.verified === rebuilt.verified &&
    cert.size === rebuilt.size &&
    cert.cost === rebuilt.cost &&
    JSON.stringify(cert.team) === JSON.stringify(rebuilt.team) &&
    JSON.stringify(cert.skillCounts) === JSON.stringify(rebuilt.skillCounts) &&
    JSON.stringify(cert.skillChecks) === JSON.stringify(rebuilt.skillChecks) &&
    JSON.stringify(cert.forbiddenPairChecks) === JSON.stringify(rebuilt.forbiddenPairChecks)
  );
}
