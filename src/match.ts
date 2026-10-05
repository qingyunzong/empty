import type { Segment } from "./pattern.js";

/**
 * Reference glob matcher: does `path` (concrete segments) match `pattern`?
 * Used by the exhaustive short-domain checker and by tests.
 */
export function matchPath(pattern: Segment[], path: string[]): boolean {
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = `${i},${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result: boolean;
    if (i === pattern.length) {
      result = j === path.length;
    } else {
      const seg = pattern[i]!;
      if (seg.kind === "dstar") {
        result = go(i + 1, j) || (j < path.length && go(i, j + 1));
      } else if (j < path.length && (seg.kind === "star" || seg.value === path[j])) {
        result = go(i + 1, j + 1);
      } else {
        result = false;
      }
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}
