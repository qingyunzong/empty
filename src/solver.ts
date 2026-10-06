import {
  Market,
  MarketInput,
  allocationToRecord,
  buildMarket,
  recordToAllocation,
} from "./model";
import { deferredAcceptance } from "./da";
import { EnumerationOptions, UnstableWitness, enumerateAllocations } from "./enumerate";
import { StabilityCertificate, buildCertificate } from "./certificate";

export interface NoStableProof {
  kind: "no-stable-proof";
  feasibleAllocationsChecked: number;
  unstableCount: number;
  /** Every feasible allocation (up to the witness cap) with a blocking pair witness. */
  unstableWitnesses: UnstableWitness[];
  truncated: boolean;
  note: string;
}

export type SolveResult =
  | {
      status: "stable";
      method: "deferred-acceptance" | "exhaustive-enumeration";
      allocation: Record<string, string>;
      certificate: StabilityCertificate;
      stableCount: number;
      feasibleCount: number | null;
    }
  | { status: "no-stable-exists"; proof: NoStableProof };

/**
 * Solves a market. Capacity-only markets use deferred acceptance; markets
 * with nested category quotas are solved by exhaustive enumeration, which
 * yields either a stability certificate or a no-stable-existence proof.
 */
export function solve(market: Market, opts: EnumerationOptions = {}): SolveResult {
  if (!market.hasQuotas) {
    const allocation = deferredAcceptance(market);
    return {
      status: "stable",
      method: "deferred-acceptance",
      allocation: allocationToRecord(allocation),
      certificate: buildCertificate(market, allocation),
      stableCount: 1,
      feasibleCount: null,
    };
  }
  const result = enumerateAllocations(market, opts);
  if (result.stableAllocations.length > 0) {
    const allocation = result.stableAllocations[0]!;
    return {
      status: "stable",
      method: "exhaustive-enumeration",
      allocation,
      certificate: buildCertificate(market, recordToAllocation(allocation)),
      stableCount: result.stableAllocations.length,
      feasibleCount: result.feasibleCount,
    };
  }
  return {
    status: "no-stable-exists",
    proof: {
      kind: "no-stable-proof",
      feasibleAllocationsChecked: result.feasibleCount,
      unstableCount: result.unstableCount,
      unstableWitnesses: result.unstableWitnesses,
      truncated: result.truncated,
      note: `enumerated all ${result.feasibleCount} feasible allocations; every one admits a blocking pair with a valid replacement set, so no stable allocation exists`,
    },
  };
}

/**
 * Withdraws applicants from the market: they are removed together with
 * their applications, and dropped from every institution preference list.
 * The returned market can be re-solved from scratch.
 */
export function withdrawApplicants(market: Market, withdrawnIds: string[]): Market {
  const withdrawn = new Set(withdrawnIds);
  for (const id of withdrawn) {
    if (!market.applicantById.has(id)) throw new Error(`unknown applicant "${id}"`);
  }
  const input: MarketInput = {
    applicants: market.applicants
      .filter((a) => !withdrawn.has(a.id))
      .map((a) => ({
        id: a.id,
        categories: [...a.categories],
        prefs: a.strictPrefs.map((id) => [id]),
      })),
    institutions: market.institutions.map((i) => ({
      id: i.id,
      capacity: i.capacity,
      quotas: i.quotas,
      prefs: i.strictPrefs.filter((id) => !withdrawn.has(id)).map((id) => [id]),
    })),
  };
  return buildMarket(input);
}
