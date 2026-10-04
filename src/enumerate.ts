import { isFeasibleSet, type Market } from "./market.js";
import { findBlockingPair, type Assignment } from "./stability.js";

export interface EnumerationResult {
  feasibleCount: number;
  stableMatchings: Record<string, string>[];
  exploredNodes: number;
  exhausted: boolean;
}

export const DEFAULT_MAX_ENUMERATION_NODES = 5_000_000;

function toRecord(assignment: Assignment, applicantIds: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const applicantId of applicantIds) {
    const institutionId = assignment.get(applicantId);
    if (institutionId !== undefined) {
      record[applicantId] = institutionId;
    }
  }
  return record;
}

export function enumerateStableMatchings(
  market: Market,
  maxNodes: number = DEFAULT_MAX_ENUMERATION_NODES,
): EnumerationResult {
  const admits = new Map<string, string[]>();
  for (const institutionId of market.institutionIds) {
    admits.set(institutionId, []);
  }

  let feasibleCount = 0;
  let exploredNodes = 0;
  let exhausted = false;
  const stableMatchings: Record<string, string>[] = [];
  const assignment: Assignment = new Map();

  const dfs = (position: number): void => {
    if (exhausted) {
      return;
    }
    exploredNodes += 1;
    if (exploredNodes > maxNodes) {
      exhausted = true;
      return;
    }
    if (position === market.applicantIds.length) {
      feasibleCount += 1;
      if (findBlockingPair(market, assignment) === null) {
        stableMatchings.push(toRecord(assignment, market.applicantIds));
      }
      return;
    }
    const applicantId = market.applicantIds[position] as string;
    const applicant = market.applicants.get(applicantId);
    if (applicant === undefined) {
      return;
    }

    dfs(position + 1);

    for (const institutionId of applicant.orderedInstitutions) {
      const institution = market.institutions.get(institutionId);
      if (institution === undefined || !institution.rankOf.has(applicantId)) {
        continue;
      }
      const held = admits.get(institutionId) as string[];
      if (!isFeasibleSet(institution, [...held, applicantId])) {
        continue;
      }
      held.push(applicantId);
      assignment.set(applicantId, institutionId);
      dfs(position + 1);
      assignment.delete(applicantId);
      held.pop();
      if (exhausted) {
        return;
      }
    }
  };

  dfs(0);

  return { feasibleCount, stableMatchings, exploredNodes, exhausted };
}
