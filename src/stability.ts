import { isFeasibleSet, mutuallyAcceptable, type Institution, type Market } from "./market.js";

export type Assignment = Map<string, string>;

export interface BlockingWitness {
  applicant: string;
  institution: string;
  replaced: string[];
  resultingAdmits: string[];
}

export interface PairCheck {
  applicant: string;
  institution: string;
  currentInstitution: string | null;
  replacementSetsExamined: number;
  blocking: BlockingWitness | null;
}

export interface Certificate {
  feasible: boolean;
  stable: boolean;
  matching: Record<string, string>;
  unassigned: string[];
  admits: Record<string, string[]>;
  checks: PairCheck[];
  blockingPairs: BlockingWitness[];
}

export function admitsOf(assignment: Assignment, institutionId: string): string[] {
  const members: string[] = [];
  for (const [applicantId, assigned] of assignment) {
    if (assigned === institutionId) {
      members.push(applicantId);
    }
  }
  return members.sort();
}

export function isFeasibleMatching(market: Market, assignment: Assignment): boolean {
  for (const [applicantId, institutionId] of assignment) {
    if (!mutuallyAcceptable(market, applicantId, institutionId)) {
      return false;
    }
  }
  for (const institutionId of market.institutionIds) {
    const institution = market.institutions.get(institutionId);
    if (institution === undefined) {
      return false;
    }
    if (!isFeasibleSet(institution, admitsOf(assignment, institutionId))) {
      return false;
    }
  }
  return true;
}

export function setValue(institution: Institution, memberIds: string[], weightBase: number): number {
  let total = 0;
  for (const id of memberIds) {
    const rank = institution.rankOf.get(id);
    if (rank !== undefined) {
      total += weightBase - rank;
    }
  }
  return total;
}

export function isImprovingReplacement(
  institution: Institution,
  current: string[],
  applicantId: string,
  replaced: string[],
  weightBase: number,
): boolean {
  const removed = new Set(replaced);
  const next = [...current.filter((id) => !removed.has(id)), applicantId];
  if (!isFeasibleSet(institution, next)) {
    return false;
  }
  return setValue(institution, next, weightBase) > setValue(institution, current, weightBase);
}

export interface ReplacementSearch {
  witness: string[] | null;
  examined: number;
}

export function findReplacementSet(
  institution: Institution,
  current: string[],
  applicantId: string,
  weightBase: number,
): ReplacementSearch {
  const size = current.length;
  const subsets: string[][] = [[]];
  for (let mask = 1; mask < 1 << size; mask += 1) {
    const subset: string[] = [];
    for (let bit = 0; bit < size; bit += 1) {
      if ((mask & (1 << bit)) !== 0) {
        subset.push(current[bit] as string);
      }
    }
    subsets.push(subset);
  }
  subsets.sort((x, y) => x.length - y.length);
  let examined = 0;
  for (const subset of subsets) {
    examined += 1;
    if (isImprovingReplacement(institution, current, applicantId, subset, weightBase)) {
      return { witness: subset, examined };
    }
  }
  return { witness: null, examined };
}

export function applicantPrefers(
  market: Market,
  assignment: Assignment,
  applicantId: string,
  institutionId: string,
): boolean {
  const applicant = market.applicants.get(applicantId);
  if (applicant === undefined || !applicant.rankOf.has(institutionId)) {
    return false;
  }
  const current = assignment.get(applicantId);
  if (current === undefined) {
    return true;
  }
  const currentRank = applicant.rankOf.get(current);
  const candidateRank = applicant.rankOf.get(institutionId);
  return currentRank !== undefined && candidateRank !== undefined && candidateRank < currentRank;
}

function buildWitness(
  assignment: Assignment,
  applicantId: string,
  institutionId: string,
  replaced: string[],
): BlockingWitness {
  const removed = new Set(replaced);
  const current = admitsOf(assignment, institutionId);
  return {
    applicant: applicantId,
    institution: institutionId,
    replaced: [...replaced].sort(),
    resultingAdmits: [...current.filter((id) => !removed.has(id)), applicantId].sort(),
  };
}

export function findBlockingPair(market: Market, assignment: Assignment): BlockingWitness | null {
  const weightBase = market.applicantIds.length + 1;
  for (const applicantId of market.applicantIds) {
    for (const institutionId of market.institutionIds) {
      const institution = market.institutions.get(institutionId) as Institution;
      if (!institution.rankOf.has(applicantId)) {
        continue;
      }
      if (!applicantPrefers(market, assignment, applicantId, institutionId)) {
        continue;
      }
      const search = findReplacementSet(institution, admitsOf(assignment, institutionId), applicantId, weightBase);
      if (search.witness !== null) {
        return buildWitness(assignment, applicantId, institutionId, search.witness);
      }
    }
  }
  return null;
}

export function certify(market: Market, assignment: Assignment): Certificate {
  const weightBase = market.applicantIds.length + 1;
  const feasible = isFeasibleMatching(market, assignment);
  const checks: PairCheck[] = [];
  const blockingPairs: BlockingWitness[] = [];

  for (const applicantId of market.applicantIds) {
    const currentInstitution = assignment.get(applicantId) ?? null;
    for (const institutionId of market.institutionIds) {
      const institution = market.institutions.get(institutionId) as Institution;
      if (!institution.rankOf.has(applicantId)) {
        continue;
      }
      if (!applicantPrefers(market, assignment, applicantId, institutionId)) {
        continue;
      }
      const search = findReplacementSet(institution, admitsOf(assignment, institutionId), applicantId, weightBase);
      let blocking: BlockingWitness | null = null;
      if (search.witness !== null) {
        blocking = buildWitness(assignment, applicantId, institutionId, search.witness);
        blockingPairs.push(blocking);
      }
      checks.push({
        applicant: applicantId,
        institution: institutionId,
        currentInstitution,
        replacementSetsExamined: search.examined,
        blocking,
      });
    }
  }

  const matching: Record<string, string> = {};
  for (const applicantId of market.applicantIds) {
    const institutionId = assignment.get(applicantId);
    if (institutionId !== undefined) {
      matching[applicantId] = institutionId;
    }
  }
  const admits: Record<string, string[]> = {};
  for (const institutionId of market.institutionIds) {
    admits[institutionId] = admitsOf(assignment, institutionId);
  }
  const unassigned = market.applicantIds.filter((id) => !assignment.has(id));

  return {
    feasible,
    stable: feasible && blockingPairs.length === 0,
    matching,
    unassigned,
    admits,
    checks,
    blockingPairs,
  };
}
