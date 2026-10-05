import type { Candidate, Instance } from "./types.js";

// Ordering: lower cost first, then fewer members, then lexicographically
// smaller sorted id list. Returns a negative number if a beats b.
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.cost !== b.cost) return a.cost - b.cost;
  if (a.size !== b.size) return a.size - b.size;
  for (let i = 0; i < a.ids.length; i++) {
    const x = a.ids[i]!;
    const y = b.ids[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Exact branch-and-bound over the 2^n subsets. People are visited cheapest
// first so the bound tightens early; two prunings keep 24 people trivial:
//   1. feasibility: counts[k] + remaining potential per skill >= required
//   2. bound: current cost/size can no longer beat the incumbent
export function solve(instance: Instance): Candidate | null {
  const n = instance.people.length;
  const skillCount = instance.skills.length;
  const required = instance.required;

  const order = instance.people.map((_, i) => i).sort((a, b) => {
    const pa = instance.people[a]!;
    const pb = instance.people[b]!;
    if (pa.cost !== pb.cost) return pa.cost - pb.cost;
    return pa.id < pb.id ? -1 : pa.id > pb.id ? 1 : 0;
  });

  // suffix[k][pos] = number of people at order positions >= pos having skill k
  const suffix: Uint8Array[] = [];
  for (let k = 0; k < skillCount; k++) {
    const arr = new Uint8Array(n + 1);
    for (let pos = n - 1; pos >= 0; pos--) {
      arr[pos] = arr[pos + 1]! + ((instance.people[order[pos]!]!.skillMask >> k) & 1);
    }
    suffix.push(arr);
  }

  const counts = new Array<number>(skillCount).fill(0);
  const chosen: number[] = [];
  let currentCost = 0;
  let best: Candidate | null = null;

  const satisfiesAll = (): boolean => {
    for (let k = 0; k < skillCount; k++) if (counts[k]! < required[k]!) return false;
    return true;
  };

  const consider = (): void => {
    const ids = chosen.map((i) => instance.people[i]!.id).sort();
    const candidate: Candidate = {
      cost: currentCost,
      size: chosen.length,
      ids,
      indices: [...chosen].sort((a, b) => a - b),
    };
    if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
  };

  const dfs = (pos: number, chosenMask: number): void => {
    for (let k = 0; k < skillCount; k++) {
      if (counts[k]! + suffix[k]![pos]! < required[k]!) return;
    }
    if (best !== null) {
      if (currentCost > best.cost) return;
      if (currentCost === best.cost && chosen.length >= best.size) {
        // Any extension is strictly worse; only the current set itself
        // (exclude everyone left) may still tie the incumbent.
        if (chosen.length === best.size && satisfiesAll()) consider();
        return;
      }
    }
    if (pos === n) {
      if (satisfiesAll()) consider();
      return;
    }
    const idx = order[pos]!;
    const person = instance.people[idx]!;
    if ((instance.forbiddenMask[idx]! & chosenMask) === 0) {
      chosen.push(idx);
      currentCost += person.cost;
      for (let k = 0; k < skillCount; k++) counts[k]! += (person.skillMask >> k) & 1;
      dfs(pos + 1, chosenMask | (1 << idx));
      for (let k = 0; k < skillCount; k++) counts[k]! -= (person.skillMask >> k) & 1;
      currentCost -= person.cost;
      chosen.pop();
    }
    dfs(pos + 1, chosenMask);
  };
  dfs(0, 0);
  return best;
}
