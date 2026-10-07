/**
 * timeline-rows: assign half-open intervals [start, end) to a minimum
 * number of display rows.
 *
 * Rules:
 *  - Items may request a fixed row; fixed requests are always honored.
 *  - Remaining items are placed in (start, id) order, each on the lowest
 *    row that does not conflict with anything already placed there.
 *  - Two half-open intervals conflict iff a.start < b.end && b.start < a.end.
 *  - Overlapping fixed requests on the same row reject the whole batch
 *    (FixedRowConflictError); nothing is assigned.
 *  - The row count is minimal: the layout searches upward from the
 *    theoretical lower bound (max of sweep-line depth and highest fixed
 *    row + 1) and takes the first feasible row count. Within that bound
 *    items are assigned in (start, id) order, lowest row first, so the
 *    result is deterministic. Without fixed rows this degenerates to the
 *    classic first-fit pass, which never needs to backtrack.
 */

export interface TimelineItem {
  id: string;
  /** Inclusive start. */
  start: number;
  /** Exclusive end; must be greater than start. */
  end: number;
  /** Optional pinned row (non-negative integer). */
  fixedRow?: number;
}

export interface LayoutResult {
  /** Number of display rows used (highest occupied row + 1). */
  rowCount: number;
  /** Item id -> assigned row. */
  rows: ReadonlyMap<string, number>;
}

export interface RowMove {
  id: string;
  /** Previous row, or null for a newly added item. */
  from: number | null;
  /** New row, or null for a removed item. */
  to: number | null;
}

export interface RelayoutResult extends LayoutResult {
  /** Row changes relative to the previous assignment. */
  moves: RowMove[];
}

export interface FixedRowConflict {
  row: number;
  ids: [string, string];
}

export class FixedRowConflictError extends Error {
  readonly conflicts: FixedRowConflict[];
  constructor(conflicts: FixedRowConflict[]) {
    super(
      `fixed row conflict(s): ${conflicts
        .map((c) => `row ${c.row}: ${c.ids[0]} vs ${c.ids[1]}`)
        .join("; ")}`,
    );
    this.name = "FixedRowConflictError";
    this.conflicts = conflicts;
  }
}

export function overlaps(
  a: Pick<TimelineItem, "start" | "end">,
  b: Pick<TimelineItem, "start" | "end">,
): boolean {
  return a.start < b.end && b.start < a.end;
}

function validate(items: readonly TimelineItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new Error(`duplicate item id: ${item.id}`);
    }
    seen.add(item.id);
    if (!(item.start < item.end)) {
      throw new Error(
        `item ${item.id}: require start < end, got [${item.start}, ${item.end})`,
      );
    }
    if (item.fixedRow !== undefined) {
      if (!Number.isInteger(item.fixedRow) || item.fixedRow < 0) {
        throw new Error(
          `item ${item.id}: fixedRow must be a non-negative integer, got ${item.fixedRow}`,
        );
      }
    }
  }
}

/** Conflicting pairs among fixed-row items sharing the same row. */
export function findFixedRowConflicts(
  items: readonly TimelineItem[],
): FixedRowConflict[] {
  const byRow = new Map<number, TimelineItem[]>();
  for (const item of items) {
    if (item.fixedRow === undefined) continue;
    const list = byRow.get(item.fixedRow);
    if (list) list.push(item);
    else byRow.set(item.fixedRow, [item]);
  }
  const conflicts: FixedRowConflict[] = [];
  for (const [row, list] of byRow) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        if (overlaps(a, b)) conflicts.push({ row, ids: [a.id, b.id] });
      }
    }
  }
  return conflicts;
}

/**
 * Lay out a batch of items. Throws FixedRowConflictError (rejecting the
 * whole batch) if any fixed-row requests overlap on the same row.
 */
export function layout(items: readonly TimelineItem[]): LayoutResult {
  validate(items);
  const conflicts = findFixedRowConflicts(items);
  if (conflicts.length > 0) throw new FixedRowConflictError(conflicts);
  if (items.length === 0) return { rowCount: 0, rows: new Map() };

  let lowerBound = sweepDepth(items);
  for (const item of items) {
    if (item.fixedRow !== undefined) {
      lowerBound = Math.max(lowerBound, item.fixedRow + 1);
    }
  }

  // Placement order: by start, then id. Fixed items keep their pinned row;
  // free items try rows from lowest to highest.
  const order = [...items].sort(
    (a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const assignment = new Int32Array(order.length);

  const fits = (rowLists: TimelineItem[][], row: number, item: TimelineItem): boolean => {
    for (const placed of rowLists[row]!) {
      if (overlaps(placed, item)) return false;
    }
    return true;
  };

  const solve = (k: number): boolean => {
    const rowLists: TimelineItem[][] = Array.from({ length: k }, () => []);
    const place = (idx: number): boolean => {
      if (idx === order.length) return true;
      const item = order[idx]!;
      const pinned = item.fixedRow;
      if (pinned !== undefined) {
        if (pinned >= k || !fits(rowLists, pinned, item)) return false;
        assignment[idx] = pinned;
        rowLists[pinned]!.push(item);
        if (place(idx + 1)) return true;
        rowLists[pinned]!.pop();
        return false;
      }
      for (let row = 0; row < k; row++) {
        if (!fits(rowLists, row, item)) continue;
        assignment[idx] = row;
        rowLists[row]!.push(item);
        if (place(idx + 1)) return true;
        rowLists[row]!.pop();
      }
      return false;
    };
    return place(0);
  };

  for (let k = lowerBound; ; k++) {
    if (solve(k)) {
      const rows = new Map<string, number>();
      order.forEach((item, i) => rows.set(item.id, assignment[i]!));
      return { rowCount: k, rows };
    }
  }
}

/**
 * Re-layout a batch and report the move delta relative to a previous
 * assignment (a LayoutResult or a plain id -> row map).
 */
export function relayout(
  previous: LayoutResult | ReadonlyMap<string, number>,
  items: readonly TimelineItem[],
): RelayoutResult {
  const prevRows =
    previous instanceof Map ? previous : (previous as LayoutResult).rows;
  const next = layout(items);
  const moves: RowMove[] = [];

  for (const item of items) {
    const to = next.rows.get(item.id)!;
    const from = prevRows.get(item.id);
    if (from === undefined) moves.push({ id: item.id, from: null, to });
    else if (from !== to) moves.push({ id: item.id, from, to });
  }
  for (const id of prevRows.keys()) {
    if (!next.rows.has(id)) moves.push({ id, from: prevRows.get(id)!, to: null });
  }

  moves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ...next, moves };
}

/** Maximum number of intervals covering any single point. */
export function sweepDepth(items: readonly TimelineItem[]): number {
  const events: { at: number; delta: number }[] = [];
  for (const item of items) {
    events.push({ at: item.start, delta: 1 }, { at: item.end, delta: -1 });
  }
  // Half-open: ends are processed before starts at the same coordinate.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let depth = 0;
  let max = 0;
  for (const e of events) {
    depth += e.delta;
    if (depth > max) max = depth;
  }
  return max;
}

/**
 * Exact minimum row count by exhaustive search, honoring fixed rows.
 * Intended for verifying `layout` on small instances. Throws
 * FixedRowConflictError on unsatisfiable fixed requests.
 */
export function bruteForceMinRows(items: readonly TimelineItem[]): number {
  validate(items);
  const conflicts = findFixedRowConflicts(items);
  if (conflicts.length > 0) throw new FixedRowConflictError(conflicts);
  if (items.length === 0) return 0;

  let lowerBound = sweepDepth(items);
  for (const item of items) {
    if (item.fixedRow !== undefined) lowerBound = Math.max(lowerBound, item.fixedRow + 1);
  }

  const assignment = new Int32Array(items.length).fill(-1);
  const feasible = (k: number): boolean => {
    const rowItems: number[][] = Array.from({ length: k }, () => []);
    const place = (idx: number): boolean => {
      if (idx === items.length) return true;
      const item = items[idx]!;
      const pinned = item.fixedRow;
      const lo = pinned === undefined ? 0 : pinned;
      const hi = pinned === undefined ? k - 1 : pinned;
      if (lo >= k) return false;
      for (let row = lo; row <= hi; row++) {
        let ok = true;
        for (const other of rowItems[row]!) {
          if (overlaps(item, items[other]!)) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        assignment[idx] = row;
        rowItems[row]!.push(idx);
        if (place(idx + 1)) return true;
        rowItems[row]!.pop();
        assignment[idx] = -1;
      }
      return false;
    };
    return place(0);
  };

  for (let k = lowerBound; ; k++) {
    if (feasible(k)) return k;
  }
}
