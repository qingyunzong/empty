import type { CategoryNodeInput, MarketInput, TieGroup } from "./types.js";

export interface CategoryNode {
  id: string;
  quota: number;
  parent: string | null;
}

export interface Applicant {
  id: string;
  categories: Set<string>;
  rankOf: Map<string, number>;
  orderedInstitutions: string[];
}

export interface Institution {
  id: string;
  capacity: number;
  rankOf: Map<string, number>;
  nodes: Map<string, CategoryNode>;
  hits: Map<string, string[]>;
}

export interface Market {
  applicants: Map<string, Applicant>;
  institutions: Map<string, Institution>;
  applicantIds: string[];
  institutionIds: string[];
}

export interface MarketLimits {
  maxApplicants: number;
  maxInstitutions: number;
}

export const DEFAULT_LIMITS: MarketLimits = { maxApplicants: 10, maxInstitutions: 6 };

function flattenPreferences(groups: TieGroup[], ownerId: string, knownIds: Set<string>): Map<string, number> {
  const rankOf = new Map<string, number>();
  let rank = 0;
  for (const group of groups) {
    const sorted = [...group].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    for (const id of sorted) {
      if (!knownIds.has(id)) {
        throw new Error(`${ownerId}: preference references unknown id "${id}"`);
      }
      if (rankOf.has(id)) {
        throw new Error(`${ownerId}: id "${id}" appears in more than one preference group`);
      }
      rankOf.set(id, rank);
      rank += 1;
    }
  }
  return rankOf;
}

function flattenQuotaTree(
  ownerId: string,
  roots: CategoryNodeInput[] | undefined,
): Map<string, CategoryNode> {
  const nodes = new Map<string, CategoryNode>();
  const visit = (node: CategoryNodeInput, parent: string | null): void => {
    if (nodes.has(node.id)) {
      throw new Error(`${ownerId}: duplicate quota category "${node.id}"`);
    }
    if (!Number.isInteger(node.quota) || node.quota < 0) {
      throw new Error(`${ownerId}: category "${node.id}" has invalid quota ${node.quota}`);
    }
    nodes.set(node.id, { id: node.id, quota: node.quota, parent });
    for (const child of node.children ?? []) {
      visit(child, node.id);
    }
  };
  for (const root of roots ?? []) {
    visit(root, null);
  }
  return nodes;
}

function ancestorClosure(nodes: Map<string, CategoryNode>, categoryId: string): string[] {
  const chain: string[] = [];
  let cursor: string | null = categoryId;
  while (cursor !== null) {
    chain.push(cursor);
    const node = nodes.get(cursor);
    cursor = node ? node.parent : null;
  }
  return chain;
}

export function buildMarket(input: MarketInput, limits: MarketLimits = DEFAULT_LIMITS): Market {
  if (input.applicants.length > limits.maxApplicants) {
    throw new Error(`too many applicants: ${input.applicants.length} > ${limits.maxApplicants}`);
  }
  if (input.institutions.length > limits.maxInstitutions) {
    throw new Error(`too many institutions: ${input.institutions.length} > ${limits.maxInstitutions}`);
  }

  const applicantIds = input.applicants.map((a) => a.id);
  const institutionIds = input.institutions.map((i) => i.id);
  const applicantIdSet = new Set(applicantIds);
  const institutionIdSet = new Set(institutionIds);
  if (applicantIdSet.size !== applicantIds.length) {
    throw new Error("duplicate applicant id");
  }
  if (institutionIdSet.size !== institutionIds.length) {
    throw new Error("duplicate institution id");
  }

  const applicants = new Map<string, Applicant>();
  for (const raw of input.applicants) {
    const rankOf = flattenPreferences(raw.prefers, `applicant ${raw.id}`, institutionIdSet);
    const orderedInstitutions = [...rankOf.entries()]
      .sort((x, y) => x[1] - y[1])
      .map(([id]) => id);
    applicants.set(raw.id, {
      id: raw.id,
      categories: new Set(raw.categories ?? []),
      rankOf,
      orderedInstitutions,
    });
  }

  const institutions = new Map<string, Institution>();
  for (const raw of input.institutions) {
    if (!Number.isInteger(raw.capacity) || raw.capacity < 0) {
      throw new Error(`institution ${raw.id}: invalid capacity ${raw.capacity}`);
    }
    const rankOf = flattenPreferences(raw.prefers, `institution ${raw.id}`, applicantIdSet);
    const nodes = flattenQuotaTree(`institution ${raw.id}`, raw.quotas);
    const hits = new Map<string, string[]>();
    for (const applicant of applicants.values()) {
      const nodeIds = new Set<string>();
      for (const category of applicant.categories) {
        if (nodes.has(category)) {
          for (const ancestor of ancestorClosure(nodes, category)) {
            nodeIds.add(ancestor);
          }
        }
      }
      hits.set(applicant.id, [...nodeIds].sort());
    }
    institutions.set(raw.id, { id: raw.id, capacity: raw.capacity, rankOf, nodes, hits });
  }

  return {
    applicants,
    institutions,
    applicantIds: [...applicantIds].sort(),
    institutionIds: [...institutionIds].sort(),
  };
}

export function isFeasibleSet(institution: Institution, memberIds: string[]): boolean {
  if (memberIds.length > institution.capacity) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const memberId of memberIds) {
    for (const nodeId of institution.hits.get(memberId) ?? []) {
      counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1);
    }
  }
  for (const [nodeId, count] of counts) {
    const node = institution.nodes.get(nodeId);
    if (node !== undefined && count > node.quota) {
      return false;
    }
  }
  return true;
}

export function mutuallyAcceptable(market: Market, applicantId: string, institutionId: string): boolean {
  const applicant = market.applicants.get(applicantId);
  const institution = market.institutions.get(institutionId);
  if (applicant === undefined || institution === undefined) {
    return false;
  }
  return applicant.rankOf.has(institutionId) && institution.rankOf.has(applicantId);
}
