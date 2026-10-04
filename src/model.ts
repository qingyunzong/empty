/**
 * Independent reference models used to cross-check WeightedRankIndex.
 */

export interface WeightedItem {
  id: string;
  value: number;
  weight: number;
}

/**
 * Per-item weight accumulation model: for every item, walk the whole list
 * and accumulate the weight of strictly smaller values plus half the weight
 * of equal values, then divide by the total weight. O(n^2) but obviously
 * correct. Empty input (or zero total weight) yields an empty map.
 */
export function naivePercentiles(items: WeightedItem[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  if (items.length === 0 || total <= 0) return out;
  for (const it of items) {
    let acc = 0;
    for (const other of items) {
      if (other.value < it.value) acc += other.weight;
      else if (other.value === it.value) acc += 0.5 * other.weight;
    }
    out.set(it.id, acc / total);
  }
  return out;
}

/**
 * Sorting model: sort items by value, walk cumulative weights, and assign
 * each group of equal values the midpoint of its cumulative weight band.
 * Empty input (or zero total weight) yields an empty map.
 */
export function sortingPercentiles(items: WeightedItem[]): Map<string, number> {
  const out = new Map<string, number>();
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  if (items.length === 0 || total <= 0) return out;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  let cumulative = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    let groupWeight = 0;
    while (j < sorted.length && sorted[j].value === sorted[i].value) {
      groupWeight += sorted[j].weight;
      j++;
    }
    const percentile = (cumulative + groupWeight / 2) / total;
    for (let k = i; k < j; k++) out.set(sorted[k].id, percentile);
    cumulative += groupWeight;
    i = j;
  }
  return out;
}
