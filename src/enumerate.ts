import {
  Allocation,
  Market,
  allocationToRecord,
  checkMembers,
} from "./model";
import { BlockingPair, findBlockingPairs } from "./stability";

export interface UnstableWitness {
  allocation: Record<string, string>;
  blockingPair: BlockingPair;
}

export interface EnumerationOptions {
  /** Safety cap on the number of feasible allocations visited. */
  maxAllocations?: number;
  /** Cap on stored instability witnesses. */
  maxWitnesses?: number;
  /** Stop after finding this many stable allocations. */
  maxStable?: number;
}

export interface EnumerationResult {
  feasibleCount: number;
  stableAllocations: Record<string, string>[];
  unstableCount: number;
  unstableWitnesses: UnstableWitness[];
  truncated: boolean;
}

/**
 * Exhaustively enumerates every feasible allocation (mutual acceptability,
 * capacities and all nested quotas), classifying each as stable or unstable.
 * For unstable allocations a witness blocking pair (with replacement set)
 * is recorded, up to `maxWitnesses`.
 */
export function enumerateAllocations(market: Market, opts: EnumerationOptions = {}): EnumerationResult {
  const maxAllocations = opts.maxAllocations ?? 1_000_000;
  const maxWitnesses = opts.maxWitnesses ?? 1_000;
  const maxStable = opts.maxStable ?? Number.POSITIVE_INFINITY;

  const applicants = market.applicants;
  const assignment = new Map<string, string>();
  const membersByInst = new Map<string, string[]>(market.institutions.map((i) => [i.id, []]));

  let feasibleCount = 0;
  let unstableCount = 0;
  let truncated = false;
  const stableAllocations: Record<string, string>[] = [];
  const unstableWitnesses: UnstableWitness[] = [];

  const dfs = (idx: number): void => {
    if (truncated || stableAllocations.length >= maxStable) return;
    if (idx === applicants.length) {
      feasibleCount++;
      if (feasibleCount > maxAllocations) {
        truncated = true;
        return;
      }
      const allocation: Allocation = new Map(assignment);
      const blocking = findBlockingPairs(market, allocation);
      if (blocking.length === 0) {
        stableAllocations.push(allocationToRecord(allocation));
      } else {
        unstableCount++;
        if (unstableWitnesses.length < maxWitnesses) {
          unstableWitnesses.push({
            allocation: allocationToRecord(allocation),
            blockingPair: blocking[0]!,
          });
        } else {
          truncated = true;
        }
      }
      return;
    }
    const applicant = applicants[idx]!;
    dfs(idx + 1); // leave unassigned
    for (const instId of applicant.strictPrefs) {
      const inst = market.institutionById.get(instId)!;
      const members = membersByInst.get(instId)!;
      members.push(applicant.id);
      if (checkMembers(market, inst, members).ok) {
        assignment.set(applicant.id, instId);
        dfs(idx + 1);
        assignment.delete(applicant.id);
      }
      members.pop();
    }
  };
  dfs(0);

  return { feasibleCount, stableAllocations, unstableCount, unstableWitnesses, truncated };
}
