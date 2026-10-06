export const MAX_APPLICANTS = 10;
export const MAX_INSTITUTIONS = 6;

/** A preference entry: a single id, or an array of ids tied at the same rank. */
export type PrefGroup = string | string[];

export interface QuotaNode {
  category: string;
  quota: number;
  children?: QuotaNode[];
}

export interface ApplicantInput {
  id: string;
  categories?: string[];
  /** Most preferred first. Ties are expressed as arrays and broken by id. */
  prefs: PrefGroup[];
}

export interface InstitutionInput {
  id: string;
  capacity: number;
  /** Forest of nested category quotas. */
  quotas?: QuotaNode[];
  prefs: PrefGroup[];
}

export interface MarketInput {
  applicants: ApplicantInput[];
  institutions: InstitutionInput[];
}

export interface Applicant {
  id: string;
  categories: string[];
  categorySet: Set<string>;
 /** Acceptable institutions, best first, ties broken by id. */
  strictPrefs: string[];
  /** institution id -> 0-based rank (absent = unacceptable). */
  rankOf: Map<string, number>;
}

export interface Institution {
  id: string;
  capacity: number;
  quotas: QuotaNode[];
  /** Acceptable applicants, best first, ties broken by id. */
  strictPrefs: string[];
  /** applicant id -> 0-based rank (absent = unacceptable). */
  rankOf: Map<string, number>;
}

export interface Market {
  applicants: Applicant[];
  institutions: Institution[];
  applicantById: Map<string, Applicant>;
  institutionById: Map<string, Institution>;
  hasQuotas: boolean;
}

/** Fixed, deterministic tie-break order on ids. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function expandPrefs(groups: PrefGroup[], owner: string, validIds: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    const members = (Array.isArray(group) ? group : [group]).slice().sort(compareIds);
    if (members.length === 0) throw new Error(`${owner}: empty tie group in preference list`);
    for (const id of members) {
      if (!validIds.has(id)) throw new Error(`${owner}: unknown id "${id}" in preference list`);
      if (seen.has(id)) throw new Error(`${owner}: duplicate id "${id}" in preference list`);
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function validateQuotaTree(nodes: QuotaNode[], instId: string, seen: Set<string>): void {
  for (const node of nodes) {
    if (typeof node.category !== "string" || node.category.length === 0) {
      throw new Error(`institution ${instId}: quota node with empty category`);
    }
    if (!Number.isInteger(node.quota) || node.quota < 0) {
      throw new Error(`institution ${instId}: quota for "${node.category}" must be a non-negative integer`);
    }
    if (seen.has(node.category)) {
      throw new Error(`institution ${instId}: duplicate quota category "${node.category}"`);
    }
    seen.add(node.category);
    validateQuotaTree(node.children ?? [], instId, seen);
  }
}

export function buildMarket(input: MarketInput): Market {
  if (!Array.isArray(input.applicants) || !Array.isArray(input.institutions)) {
    throw new Error("market input must contain applicants and institutions arrays");
  }
  if (input.applicants.length > MAX_APPLICANTS) {
    throw new Error(`too many applicants: ${input.applicants.length} > ${MAX_APPLICANTS}`);
  }
  if (input.institutions.length > MAX_INSTITUTIONS) {
    throw new Error(`too many institutions: ${input.institutions.length} > ${MAX_INSTITUTIONS}`);
  }
  const applicantIds = new Set<string>();
  const institutionIds = new Set<string>();
  for (const a of input.applicants) {
    if (applicantIds.has(a.id)) throw new Error(`duplicate applicant id "${a.id}"`);
    applicantIds.add(a.id);
  }
  for (const i of input.institutions) {
    if (institutionIds.has(i.id)) throw new Error(`duplicate institution id "${i.id}"`);
    institutionIds.add(i.id);
  }
  for (const id of applicantIds) {
    if (institutionIds.has(id)) throw new Error(`id "${id}" used as both applicant and institution`);
  }

  const applicants: Applicant[] = input.applicants.map((a) => {
    const strictPrefs = expandPrefs(a.prefs, `applicant ${a.id}`, institutionIds);
    const categories = [...new Set(a.categories ?? [])].sort(compareIds);
    return {
      id: a.id,
      categories,
      categorySet: new Set(categories),
      strictPrefs,
      rankOf: new Map(strictPrefs.map((id, idx) => [id, idx] as const)),
    };
  });

  let hasQuotas = false;
  const institutions: Institution[] = input.institutions.map((i) => {
    if (!Number.isInteger(i.capacity) || i.capacity < 0) {
      throw new Error(`institution ${i.id}: capacity must be a non-negative integer`);
    }
    const quotas = i.quotas ?? [];
    validateQuotaTree(quotas, i.id, new Set());
    if (quotas.length > 0) hasQuotas = true;
    const strictPrefs = expandPrefs(i.prefs, `institution ${i.id}`, applicantIds);
    return {
      id: i.id,
      capacity: i.capacity,
      quotas,
      strictPrefs,
      rankOf: new Map(strictPrefs.map((id, idx) => [id, idx] as const)),
    };
  });

  return {
    applicants,
    institutions,
    applicantById: new Map(applicants.map((a) => [a.id, a] as const)),
    institutionById: new Map(institutions.map((i) => [i.id, i] as const)),
    hasQuotas,
  };
}

/** applicant id -> institution id (only assigned applicants present). */
export type Allocation = ReadonlyMap<string, string>;

export function membersOf(allocation: Allocation, institutionId: string): string[] {
  const out: string[] = [];
  for (const [a, i] of allocation) if (i === institutionId) out.push(a);
  return out.sort(compareIds);
}

export function allocationToRecord(allocation: Allocation): Record<string, string> {
  const rec: Record<string, string> = {};
  for (const key of [...allocation.keys()].sort(compareIds)) rec[key] = allocation.get(key)!;
  return rec;
}

export function recordToAllocation(rec: Record<string, string>): Allocation {
  return new Map(Object.entries(rec));
}

export interface QuotaCount {
  path: string;
  category: string;
  count: number;
  quota: number;
  ok: boolean;
}

export function quotaCounts(
  market: Market,
  inst: Institution,
  memberIds: readonly string[],
): QuotaCount[] {
  const out: QuotaCount[] = [];
  const walk = (nodes: QuotaNode[], prefix: string): void => {
    for (const node of nodes) {
      const path = prefix ? `${prefix}/${node.category}` : node.category;
      let count = 0;
      for (const id of memberIds) {
        const applicant = market.applicantById.get(id);
        if (applicant && applicant.categorySet.has(node.category)) count++;
      }
      out.push({ path, category: node.category, count, quota: node.quota, ok: count <= node.quota });
      walk(node.children ?? [], path);
    }
  };
  walk(inst.quotas, "");
  return out;
}

export interface MemberCheck {
  ok: boolean;
  size: number;
  capacity: number;
  quotas: QuotaCount[];
  violations: string[];
}

export function checkMembers(
  market: Market,
  inst: Institution,
  memberIds: readonly string[],
): MemberCheck {
  const violations: string[] = [];
  for (const id of memberIds) {
    if (!inst.rankOf.has(id)) {
      violations.push(`institution ${inst.id}: member ${id} is unacceptable`);
    }
  }
  if (memberIds.length > inst.capacity) {
    violations.push(`institution ${inst.id}: size ${memberIds.length} exceeds capacity ${inst.capacity}`);
  }
  const quotas = quotaCounts(market, inst, memberIds);
  for (const q of quotas) {
    if (!q.ok) violations.push(`institution ${inst.id}: quota ${q.path} count ${q.count} exceeds ${q.quota}`);
  }
  return { ok: violations.length === 0, size: memberIds.length, capacity: inst.capacity, quotas, violations };
}

/** Returns the list of feasibility violations of an allocation (empty = feasible). */
export function checkAllocation(market: Market, allocation: Allocation): string[] {
  const violations: string[] = [];
  for (const [aId, iId] of allocation) {
    const applicant = market.applicantById.get(aId);
    const inst = market.institutionById.get(iId);
    if (!applicant) {
      violations.push(`unknown applicant ${aId}`);
      continue;
    }
    if (!inst) {
      violations.push(`unknown institution ${iId}`);
      continue;
    }
    if (!applicant.rankOf.has(iId)) {
      violations.push(`institution ${iId} is unacceptable to applicant ${aId}`);
    }
  }
  for (const inst of market.institutions) {
    violations.push(...checkMembers(market, inst, membersOf(allocation, inst.id)).violations);
  }
  return violations;
}
