import {
  Allocation,
  Market,
  allocationToRecord,
  checkAllocation,
  checkMembers,
  membersOf,
  recordToAllocation,
} from "./model";
import { findBlockingPairs } from "./stability";

export interface QuotaEvidence {
  path: string;
  category: string;
  count: number;
  quota: number;
}

export interface InstitutionEvidence {
  institution: string;
  members: string[];
  size: number;
  capacity: number;
  quotas: QuotaEvidence[];
}

export interface NonBlockingEvidence {
  applicant: string;
  institution: string;
  reason: "institution-finds-applicant-unacceptable" | "no-valid-replacement-set";
  currentMembers: string[];
  /** Number of replacement subsets examined (2^|currentMembers|), 0 if not applicable. */
  subsetsChecked: number;
}

/**
 * A no-blocking-pair certificate: feasibility evidence per institution plus,
 * for every (applicant, institution) pair the applicant would prefer over
 * their current seat, the reason the pair cannot block.
 */
export interface StabilityCertificate {
  kind: "stability-certificate";
  allocation: Record<string, string>;
  unassigned: string[];
  feasibility: InstitutionEvidence[];
  nonBlocking: NonBlockingEvidence[];
}

export function buildCertificate(market: Market, allocation: Allocation): StabilityCertificate {
  const violations = checkAllocation(market, allocation);
  if (violations.length > 0) {
    throw new Error(`cannot certify infeasible allocation: ${violations.join("; ")}`);
  }
  const blocking = findBlockingPairs(market, allocation);
  if (blocking.length > 0) {
    throw new Error(`cannot certify unstable allocation; first blocking pair: ${JSON.stringify(blocking[0])}`);
  }

  const feasibility: InstitutionEvidence[] = market.institutions.map((inst) => {
    const members = membersOf(allocation, inst.id);
    const check = checkMembers(market, inst, members);
    const byRank = members
      .slice()
      .sort((x, y) => inst.rankOf.get(x)! - inst.rankOf.get(y)!);
    return {
      institution: inst.id,
      members: byRank,
      size: members.length,
      capacity: inst.capacity,
      quotas: check.quotas.map(({ path, category, count, quota }) => ({ path, category, count, quota })),
    };
  });

  const nonBlocking: NonBlockingEvidence[] = [];
  for (const applicant of market.applicants) {
    const current = allocation.get(applicant.id) ?? null;
    for (const inst of market.institutions) {
      if (current === inst.id) continue;
      const rank = applicant.rankOf.get(inst.id);
      if (rank === undefined) continue;
      if (current !== null && rank >= applicant.rankOf.get(current)!) continue;
      const members = membersOf(allocation, inst.id);
      if (!inst.rankOf.has(applicant.id)) {
        nonBlocking.push({
          applicant: applicant.id,
          institution: inst.id,
          reason: "institution-finds-applicant-unacceptable",
          currentMembers: members,
          subsetsChecked: 0,
        });
      } else {
        nonBlocking.push({
          applicant: applicant.id,
          institution: inst.id,
          reason: "no-valid-replacement-set",
          currentMembers: members,
          subsetsChecked: 2 ** members.length,
        });
      }
    }
  }

  const assigned = new Set(allocation.keys());
  return {
    kind: "stability-certificate",
    allocation: allocationToRecord(allocation),
    unassigned: market.applicants.filter((a) => !assigned.has(a.id)).map((a) => a.id),
    feasibility,
    nonBlocking,
  };
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
    return out;
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

/**
 * Independently verifies a stability certificate: re-checks feasibility,
 * re-enumerates all blocking pairs / replacement sets, and confirms the
 * certificate content matches a full recomputation.
 */
export function verifyCertificate(
  market: Market,
  cert: StabilityCertificate,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (cert.kind !== "stability-certificate") errors.push(`unexpected kind: ${cert.kind}`);

  const allocation: Allocation = recordToAllocation(cert.allocation);
  for (const applicant of market.applicants) {
    const assigned = allocation.has(applicant.id);
    const listedUnassigned = cert.unassigned.includes(applicant.id);
    if (assigned === listedUnassigned) {
      errors.push(`applicant ${applicant.id}: assignment/unassigned mismatch`);
    }
  }

  errors.push(...checkAllocation(market, allocation));

  const blocking = findBlockingPairs(market, allocation);
  if (blocking.length > 0) {
    errors.push(`allocation has ${blocking.length} blocking pair(s), e.g. ${JSON.stringify(blocking[0])}`);
  }

  if (errors.length === 0) {
    const expected = buildCertificate(market, allocation);
    if (canonical(expected) !== canonical(cert)) {
      errors.push("certificate content does not match independent recomputation");
    }
  }
  return { ok: errors.length === 0, errors };
}
