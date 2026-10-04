import type { MarketInput, TieGroup } from "../src/types.js";

export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffled<T>(rng: () => number, items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = tmp;
  }
  return copy;
}

function toTieGroups(rng: () => number, ids: string[], tieProbability: number): TieGroup[] {
  const groups: TieGroup[] = [];
  let index = 0;
  while (index < ids.length) {
    const group = [ids[index] as string];
    index += 1;
    while (index < ids.length && group.length < 2 && rng() < tieProbability) {
      group.push(ids[index] as string);
      index += 1;
    }
    groups.push(group);
  }
  return groups;
}

const CATEGORY_POOL = ["sci", "phy", "art", "mus"];

export function randomMarket(
  seed: number,
  applicantCount: number,
  institutionCount: number,
): MarketInput {
  const rng = makeRng(seed);
  const applicantIds = Array.from({ length: applicantCount }, (_, i) => `a${i + 1}`);
  const institutionIds = Array.from({ length: institutionCount }, (_, i) => `i${i + 1}`);

  const applicants = applicantIds.map((id) => {
    const categories = CATEGORY_POOL.filter(() => rng() < 0.3);
    const kept = shuffled(rng, institutionIds).filter(() => rng() < 0.75);
    return { id, categories, prefers: toTieGroups(rng, kept, 0.2) };
  });

  const institutions = institutionIds.map((id) => {
    const capacity = 1 + Math.floor(rng() * 2);
    const quotas = [];
    if (rng() < 0.7) {
      const sciQuota = 1 + Math.floor(rng() * capacity);
      quotas.push({
        id: "sci",
        quota: sciQuota,
        children: [{ id: "phy", quota: Math.max(1, Math.floor(rng() * (sciQuota + 1))) }],
      });
    }
    if (rng() < 0.5) {
      quotas.push({ id: "art", quota: 1 + Math.floor(rng() * capacity) });
    }
    if (rng() < 0.3) {
      quotas.push({ id: "mus", quota: 1 });
    }
    const kept = shuffled(rng, applicantIds).filter(() => rng() < 0.85);
    return { id, capacity, quotas, prefers: toTieGroups(rng, kept, 0.15) };
  });

  return { applicants, institutions };
}
