/**
 * Brute-force per-unit-cell reference model for tiny integer grids.
 *
 * Used as a test oracle: for every unit cell [x, x+1) x [y, y+1) it
 * computes the exact set of source ids covering the cell, directly from
 * the stored entries. Only suitable for small coordinate ranges.
 */

import type { CoveredRect, Entry } from "./rectdb.js";

/** Cell key "x,y" -> sorted source ids covering that unit cell. */
export type CellMap = Map<string, string[]>;

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/** Exact per-cell source sets for every cell touched by any entry. */
export function modelCells(entries: Iterable<Entry>): CellMap {
  const counts = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const { x0, y0, x1, y1 } = entry.rect;
    for (let x = x0; x < x1; x++) {
      for (let y = y0; y < y1; y++) {
        const key = cellKey(x, y);
        let m = counts.get(key);
        if (m === undefined) counts.set(key, (m = new Map()));
        m.set(entry.source, (m.get(entry.source) ?? 0) + 1);
      }
    }
  }
  const cells: CellMap = new Map();
  for (const [key, m] of counts) cells.set(key, [...m.keys()].sort());
  return cells;
}

/** Cells whose covering source set has size >= k. */
export function modelCellsAtLeast(entries: Iterable<Entry>, k: number): CellMap {
  const all = modelCells(entries);
  const out: CellMap = new Map();
  for (const [key, sources] of all) {
    if (sources.length >= k) out.set(key, sources);
  }
  return out;
}

export interface Mismatch {
  readonly kind:
    | "overlap"
    | "unsorted-sources"
    | "duplicate-source"
    | "too-few-sources"
    | "non-integer-bounds"
    | "empty-rect"
    | "cell-sources-differ"
    | "cell-missing"
    | "cell-unexpected";
  readonly detail: string;
}

/**
 * Verify that `covered` is an exact disjoint decomposition of the >=k
 * covered region described by the per-cell model, with per-cell source
 * sets matching. Returns the list of mismatches (empty when correct).
 */
export function verifyAgainstModel(
  entries: Iterable<Entry>,
  k: number,
  covered: readonly CoveredRect[],
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const seen: CellMap = new Map();

  for (const r of covered) {
    if (!Number.isInteger(r.x0) || !Number.isInteger(r.y0) ||
        !Number.isInteger(r.x1) || !Number.isInteger(r.y1)) {
      mismatches.push({ kind: "non-integer-bounds", detail: JSON.stringify(r) });
      continue;
    }
    if (!(r.x0 < r.x1) || !(r.y0 < r.y1)) {
      mismatches.push({ kind: "empty-rect", detail: JSON.stringify(r) });
      continue;
    }
    if (r.sources.length < k) {
      mismatches.push({ kind: "too-few-sources", detail: JSON.stringify(r) });
    }
    for (let j = 1; j < r.sources.length; j++) {
      if (r.sources[j - 1] === r.sources[j]) {
        mismatches.push({ kind: "duplicate-source", detail: JSON.stringify(r.sources) });
      }
      if (!(r.sources[j - 1]! < r.sources[j]!)) {
        mismatches.push({ kind: "unsorted-sources", detail: JSON.stringify(r.sources) });
      }
    }
    for (let x = r.x0; x < r.x1; x++) {
      for (let y = r.y0; y < r.y1; y++) {
        const key = cellKey(x, y);
        if (seen.has(key)) {
          mismatches.push({ kind: "overlap", detail: `cell ${key} covered twice` });
        }
        seen.set(key, [...r.sources]);
      }
    }
  }

  const expected = modelCellsAtLeast(entries, k);
  for (const [key, sources] of expected) {
    const got = seen.get(key);
    if (got === undefined) {
      mismatches.push({ kind: "cell-missing", detail: `cell ${key} wants ${sources.join("|")}` });
    } else if (got.join("") !== sources.join("")) {
      mismatches.push({
        kind: "cell-sources-differ",
        detail: `cell ${key}: got ${got.join("|")}, want ${sources.join("|")}`,
      });
    }
  }
  for (const key of seen.keys()) {
    if (!expected.has(key)) {
      mismatches.push({ kind: "cell-unexpected", detail: `cell ${key}` });
    }
  }
  return mismatches;
}

/** Total area of a covered-rect list. */
export function totalArea(covered: readonly CoveredRect[]): number {
  let area = 0;
  for (const r of covered) area += (r.x1 - r.x0) * (r.y1 - r.y0);
  return area;
}
