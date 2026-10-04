import type { UserSpec } from "./allocator.js";

/**
 * Per-unit reference model ("逐单位小容量模型").
 *
 * Capacity is handed out one indivisible unit at a time. Each unit goes to
 * the still-unsatisfied user with the smallest allocated/weight ratio
 * (ties broken by ascending user ID). This is the canonical greedy
 * construction of weighted max-min fairness and serves as the ground-truth
 * cross-check for the round-based batch allocator on small capacities.
 */
export function allocateByUnit(specs: UserSpec[], capacity: number): Map<string, number> {
  if (!Number.isInteger(capacity) || capacity < 0) {
    throw new Error("capacity must be a non-negative integer");
  }
  const users = specs
    .map((s) => ({
      id: s.id,
      limit: Math.min(s.demand, s.cap ?? s.demand),
      weight: BigInt(s.weight),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const granted = new Map<string, bigint>(users.map((u) => [u.id, 0n]));

  for (let unit = 0; unit < capacity; unit += 1) {
    let best: (typeof users)[number] | undefined;
    for (const u of users) {
      const current = granted.get(u.id) ?? 0n;
      if (current >= BigInt(u.limit)) continue;
      if (best === undefined) {
        best = u;
        continue;
      }
      const bestGranted = granted.get(best.id) ?? 0n;
      // Compare current/u.weight vs bestGranted/best.weight via cross-multiplication.
      const lhs = current * best.weight;
      const rhs = bestGranted * u.weight;
      if (lhs < rhs) best = u;
      // Equal ratios keep the earlier (smaller) ID because users are ID-sorted.
    }
    if (best === undefined) break; // everyone saturated
    granted.set(best.id, (granted.get(best.id) ?? 0n) + 1n);
  }

  const result = new Map<string, number>();
  for (const [id, value] of granted) result.set(id, Number(value));
  return result;
}
