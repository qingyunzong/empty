import {
  Allocation,
  Market,
  checkAllocation,
  checkMembers,
  compareIds,
  membersOf,
} from "./model";

/**
 * A blocking pair (applicant, institution) together with one explicit
 * replacement set: the institution rejects `replacementSet` (possibly empty)
 * from its current members and admits `applicant`, producing
 * `resultingMembers`, which satisfies capacity and every nested quota.
 *
 * Explicit replacement rule: the deviation is profitable for the institution
 * iff the new applicant is strictly preferred (after id tie-breaking) to
 * EVERY rejected member. An empty replacement set (pure addition) is always
 * profitable for the institution.
 */
export interface BlockingPair {
  applicant: string;
  institution: string;
  replacementSet: string[];
  resultingMembers: string[];
}

function sortByInstitutionRank(market: Market, instId: string, ids: string[]): string[] {
  const inst = market.institutionById.get(instId)!;
  return ids.slice().sort((x, y) => inst.rankOf.get(x)! - inst.rankOf.get(y)!);
}

/**
 * Enumerates every blocking pair of the allocation, with one entry per
 * valid replacement set (i.e. all blocking replacement sets are listed).
 */
export function findBlockingPairs(market: Market, allocation: Allocation): BlockingPair[] {
  const out: BlockingPair[] = [];
  for (const applicant of market.applicants) {
    const current = allocation.get(applicant.id) ?? null;
    for (const inst of market.institutions) {
      if (current === inst.id) continue;
      const rank = applicant.rankOf.get(inst.id);
      if (rank === undefined) continue; // institution unacceptable to applicant
      if (current !== null && rank >= applicant.rankOf.get(current)!) continue; // not preferred
      const applicantRank = inst.rankOf.get(applicant.id);
      if (applicantRank === undefined) continue; // applicant unacceptable to institution

      const members = membersOf(allocation, inst.id);
      const n = members.length;
      for (let mask = 0; mask < 1 << n; mask++) {
        const rejected: string[] = [];
        let profitable = true;
        for (let bit = 0; bit < n; bit++) {
          if ((mask & (1 << bit)) !== 0) {
            const member = members[bit]!;
            if (inst.rankOf.get(member)! <= applicantRank) {
              profitable = false;
              break;
            }
            rejected.push(member);
          }
        }
        if (!profitable) continue;
        const rejectedSet = new Set(rejected);
        const resulting = members.filter((m) => !rejectedSet.has(m));
        resulting.push(applicant.id);
        if (checkMembers(market, inst, resulting).ok) {
          out.push({
            applicant: applicant.id,
            institution: inst.id,
            replacementSet: rejected.sort(compareIds),
            resultingMembers: sortByInstitutionRank(market, inst.id, resulting),
          });
        }
      }
    }
  }
  return out;
}

export function isStable(market: Market, allocation: Allocation): boolean {
  return checkAllocation(market, allocation).length === 0 && findBlockingPairs(market, allocation).length === 0;
}
