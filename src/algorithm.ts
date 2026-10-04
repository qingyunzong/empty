import { isFeasibleSet, type Institution, type Market } from "./market.js";
import type { Assignment } from "./stability.js";

export function greedyChoice(institution: Institution, pool: string[]): string[] {
  const ordered = [...pool].sort((x, y) => {
    const rx = institution.rankOf.get(x) as number;
    const ry = institution.rankOf.get(y) as number;
    return rx - ry;
  });
  const kept: string[] = [];
  for (const id of ordered) {
    if (isFeasibleSet(institution, [...kept, id])) {
      kept.push(id);
    }
  }
  return kept;
}

export function deferredAcceptance(market: Market): Assignment {
  const current = new Map<string, string[]>();
  const nextIndex = new Map<string, number>();
  const pending = new Set<string>();
  for (const applicantId of market.applicantIds) {
    const applicant = market.applicants.get(applicantId);
    if (applicant !== undefined && applicant.orderedInstitutions.length > 0) {
      pending.add(applicantId);
    }
    nextIndex.set(applicantId, 0);
  }

  for (;;) {
    let proposer: string | null = null;
    for (const applicantId of [...pending].sort()) {
      const applicant = market.applicants.get(applicantId);
      const index = nextIndex.get(applicantId) as number;
      if (applicant !== undefined && index < applicant.orderedInstitutions.length) {
        proposer = applicantId;
        break;
      }
      pending.delete(applicantId);
    }
    if (proposer === null) {
      break;
    }

    const applicant = market.applicants.get(proposer);
    if (applicant === undefined) {
      pending.delete(proposer);
      continue;
    }
    const index = nextIndex.get(proposer) as number;
    nextIndex.set(proposer, index + 1);
    const institutionId = applicant.orderedInstitutions[index] as string;
    const institution = market.institutions.get(institutionId);
    if (institution === undefined || !institution.rankOf.has(proposer)) {
      continue;
    }

    const held = current.get(institutionId) ?? [];
    const pool = [...held, proposer];
    const chosen = greedyChoice(institution, pool);
    current.set(institutionId, chosen);
    const chosenSet = new Set(chosen);
    for (const id of pool) {
      if (!chosenSet.has(id)) {
        pending.add(id);
      }
    }
    if (chosenSet.has(proposer)) {
      pending.delete(proposer);
    }
  }

  const assignment: Assignment = new Map();
  for (const [institutionId, members] of current) {
    for (const applicantId of members) {
      assignment.set(applicantId, institutionId);
    }
  }
  return assignment;
}
