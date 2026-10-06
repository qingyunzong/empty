import { MarketInput, PrefGroup, QuotaNode } from "../src/model";

/** Deterministic PRNG so tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOptions {
  applicants: number;
  institutions: number;
  maxCapacity: number;
  categories: string[];
  /** Probability of including each category for an applicant. */
  categoryProb: number;
  /** Probability that an institution gets a quota tree. */
  quotaProb: number;
  /** Probability of merging adjacent pref entries into a tie group. */
  tieProb: number;
  /** Probability of keeping an entry in a preference list. */
  acceptProb: number;
}

function shuffled<T>(rng: () => number, items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function randomPrefs(rng: () => number, ids: string[], acceptProb: number, tieProb: number): PrefGroup[] {
  const kept = shuffled(rng, ids).filter(() => rng() < acceptProb);
  const groups: PrefGroup[] = [];
  let i = 0;
  while (i < kept.length) {
    if (i + 1 < kept.length && rng() < tieProb) {
      groups.push([kept[i]!, kept[i + 1]!]);
      i += 2;
    } else {
      groups.push(kept[i]!);
      i += 1;
    }
  }
  return groups;
}

function randomQuotaTree(rng: () => number, categories: string[], capacity: number): QuotaNode[] {
  const nodes: QuotaNode[] = [];
  const pool = shuffled(rng, categories);
  const roots = pool.slice(0, 1 + Math.floor(rng() * Math.min(2, categories.length)));
  const used = new Set(roots);
  for (const category of roots) {
    const node: QuotaNode = { category, quota: Math.floor(rng() * (capacity + 1)) };
    if (categories.length > 1 && rng() < 0.5) {
      const candidates = pool.filter((c) => !used.has(c));
      if (candidates.length > 0) {
        const childCategory = candidates[Math.floor(rng() * candidates.length)]!;
        used.add(childCategory);
        node.children = [{ category: childCategory, quota: Math.floor(rng() * (node.quota + 1)) }];
      }
    }
    nodes.push(node);
  }
  return nodes;
}

export function randomMarketInput(rng: () => number, opts: GenOptions): MarketInput {
  const applicantIds = Array.from({ length: opts.applicants }, (_, i) => `a${i + 1}`);
  const institutionIds = Array.from({ length: opts.institutions }, (_, i) => `i${i + 1}`);
  return {
    applicants: applicantIds.map((id) => ({
      id,
      categories: opts.categories.filter(() => rng() < opts.categoryProb),
      prefs: randomPrefs(rng, institutionIds, opts.acceptProb, opts.tieProb),
    })),
    institutions: institutionIds.map((id) => {
      const capacity = 1 + Math.floor(rng() * opts.maxCapacity);
      const quotas =
        opts.categories.length > 0 && rng() < opts.quotaProb
          ? randomQuotaTree(rng, opts.categories, capacity)
          : [];
      return {
        id,
        capacity,
        quotas,
        prefs: randomPrefs(rng, applicantIds, opts.acceptProb, opts.tieProb),
      };
    }),
  };
}
