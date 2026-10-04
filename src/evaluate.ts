import type { Change, QuerySpec, ResultEntry, Row } from "./types.js";

export function groupSums(
  rows: Iterable<Row>,
  spec: QuerySpec,
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const row of rows) {
    if (!spec.filter(row)) continue;
    sums.set(row.key, (sums.get(row.key) ?? 0) + row.value);
  }
  return sums;
}

export function groupCounts(
  rows: Iterable<Row>,
  spec: QuerySpec,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!spec.filter(row)) continue;
    counts.set(row.key, (counts.get(row.key) ?? 0) + 1);
  }
  return counts;
}

export function compareEntries(a: ResultEntry, b: ResultEntry): number {
  if (a.sum !== b.sum) return b.sum - a.sum;
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0;
}

export function topK(
  sums: ReadonlyMap<string, number>,
  k: number,
): ResultEntry[] {
  const entries: ResultEntry[] = [];
  for (const [key, sum] of sums) entries.push({ key, sum });
  entries.sort(compareEntries);
  return entries.slice(0, Math.max(0, k));
}

export function evaluate(
  rows: Iterable<Row>,
  spec: QuerySpec,
): ResultEntry[] {
  return topK(groupSums(rows, spec), spec.k);
}

export function diffResults(
  oldResult: ResultEntry[],
  newResult: ResultEntry[],
): Change[] {
  const oldMap = new Map(oldResult.map((e) => [e.key, e.sum]));
  const newMap = new Map(newResult.map((e) => [e.key, e.sum]));
  const changes: Change[] = [];
  for (const [key, oldSum] of oldMap) {
    if (!newMap.has(key)) changes.push({ key, oldSum, newSum: null });
  }
  for (const [key, newSum] of newMap) {
    const oldSum = oldMap.get(key);
    if (oldSum === undefined) changes.push({ key, oldSum: null, newSum });
    else if (oldSum !== newSum) changes.push({ key, oldSum, newSum });
  }
  changes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return changes;
}

export function sameEntries(a: ResultEntry[], b: ResultEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.key !== y.key || x.sum !== y.sum) return false;
  }
  return true;
}
