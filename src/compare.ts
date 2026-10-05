/** A candidate team ranked by (cost, size, sorted id list). */
export interface RankedTeam {
  cost: number;
  size: number;
  /** Sorted team member ids. */
  ids: string[];
}

/** Lexicographic comparison of two sorted id lists (code-unit order). */
export function compareIdLists(a: string[], b: string[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

/**
 * Total order over teams: lower cost first, then fewer members,
 * then lexicographically smaller sorted id list.
 */
export function compareRanked(a: RankedTeam, b: RankedTeam): number {
  if (a.cost !== b.cost) return a.cost < b.cost ? -1 : 1;
  if (a.size !== b.size) return a.size - b.size;
  return compareIdLists(a.ids, b.ids);
}
