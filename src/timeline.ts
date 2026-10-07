/**
 * timeline-rows: assign half-open intervals [start, end) to a minimum number
 * of display rows so that overlapping intervals never share a row.
 *
 * Rules:
 *  - Fixed row requests (`fixedRow`) are always honored.
 *  - Any conflict between fixed requests rejects the whole batch
 *    (FixedRowConflictError) before anything is assigned.
 *  - Remaining items are placed in (start, id) order, each on the lowest
 *    row that is free for its time span.
 *  - If fixed constraints push that greedy pass above the true minimum,
 *    the layout is rearranged exactly: items are still considered in
 *    (start, id) order and still prefer lower rows, but only choices that
 *    keep a minimum-row completion possible are taken.
 *  - Re-layout is supported: pass the previous layout to receive move deltas.
 */

export interface TimelineItem {
  id: string;
  /** Inclusive start of the half-open interval. */
  start: number;
  /** Exclusive end of the half-open interval. */
  end: number;
  /** Optional fixed row the item must be placed on (0-based). */
  fixedRow?: number;
}

export interface MoveDelta {
  id: string;
  /** Previous row, or null when the item was added. */
  from: number | null;
  /** New row, or null when the item was removed. */
  to: number | null;
}

export interface LayoutResult {
  /** Total number of display rows used (the minimum achievable). */
  rowCount: number;
  /** Item id -> assigned row. */
  rows: ReadonlyMap<string, number>;
  /**
   * Differences against the previous layout (added / removed / moved),
   * sorted by id. Empty when no previous layout was supplied.
   */
  moves: readonly MoveDelta[];
}

export interface FixedRowConflict {
  row: number;
  firstId: string;
  secondId: string;
}

export class InvalidTimelineItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTimelineItemError";
  }
}

export class FixedRowConflictError extends Error {
  readonly conflicts: readonly FixedRowConflict[];

  constructor(conflicts: readonly FixedRowConflict[]) {
    super(
      "fixed row conflict(s): " +
        conflicts
          .map((c) => `row ${c.row}: "${c.firstId}" overlaps "${c.secondId}"`)
          .join("; ")
    );
    this.name = "FixedRowConflictError";
    this.conflicts = conflicts;
  }
}

/** Previous layout, as a Map or a plain id -> row object. */
export type PreviousLayout =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>;

/** Half-open overlap: [a.start, a.end) intersects [b.start, b.end). */
export function overlaps(a: TimelineItem, b: TimelineItem): boolean {
  return a.start < b.end && b.start < a.end;
}

function validateItems(items: readonly TimelineItem[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new InvalidTimelineItemError(`item has a missing or empty id`);
    }
    if (seen.has(item.id)) {
      throw new InvalidTimelineItemError(`duplicate item id "${item.id}"`);
    }
    seen.add(item.id);
    if (!Number.isFinite(item.start) || !Number.isFinite(item.end)) {
      throw new InvalidTimelineItemError(
        `item "${item.id}" has non-finite start/end`
      );
    }
    if (!(item.start < item.end)) {
      throw new InvalidTimelineItemError(
        `item "${item.id}" must satisfy start < end (got [${item.start}, ${item.end}))`
      );
    }
    if (item.fixedRow !== undefined) {
      if (!Number.isInteger(item.fixedRow) || item.fixedRow < 0) {
        throw new InvalidTimelineItemError(
          `item "${item.id}" has invalid fixedRow ${item.fixedRow} (must be an integer >= 0)`
        );
      }
    }
  }
}

function findFixedConflicts(
  items: readonly TimelineItem[]
): FixedRowConflict[] {
  const fixed = items.filter((item) => item.fixedRow !== undefined);
  const conflicts: FixedRowConflict[] = [];
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      const a = fixed[i]!;
      const b = fixed[j]!;
      if (a.fixedRow === b.fixedRow && overlaps(a, b)) {
        conflicts.push({
          row: a.fixedRow!,
          firstId: a.id,
          secondId: b.id,
        });
      }
    }
  }
  return conflicts;
}

function compareByStartThenId(a: TimelineItem, b: TimelineItem): number {
  if (a.start !== b.start) return a.start - b.start;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function normalizePrevious(previous: PreviousLayout): Map<string, number> {
  if (previous instanceof Map) return new Map(previous);
  return new Map(Object.entries(previous));
}

/**
 * Certified lower bound on the number of rows: the maximum overlap depth,
 * the highest fixed row + 1, and, for every item, the number of distinct
 * fixed rows it overlaps (plus its own row).
 */
function certifiedLowerBound(items: readonly TimelineItem[]): number {
  if (items.length === 0) return 0;
  let bound = 1;

  const events: Array<[number, number]> = [];
  for (const item of items) {
    events.push([item.start, 1], [item.end, -1]);
  }
  // Ends sort before starts at the same instant (half-open intervals).
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let depth = 0;
  for (const [, delta] of events) {
    depth += delta;
    if (depth > bound) bound = depth;
  }

  for (const item of items) {
    const blockedRows = new Set<number>();
    if (item.fixedRow !== undefined) {
      blockedRows.add(item.fixedRow);
      if (item.fixedRow + 1 > bound) bound = item.fixedRow + 1;
    }
    for (const other of items) {
      if (
        other !== item &&
        other.fixedRow !== undefined &&
        overlaps(item, other)
      ) {
        blockedRows.add(other.fixedRow);
      }
    }
    const needed = blockedRows.size + (item.fixedRow === undefined ? 1 : 0);
    if (needed > bound) bound = needed;
  }
  return bound;
}

function buildOverlapMatrix(ordered: readonly TimelineItem[]): boolean[][] {
  return ordered.map((item) => ordered.map((other) => overlaps(item, other)));
}

type SearchResult =
  | { status: "found"; assignment: number[] }
  | { status: "infeasible" }
  | { status: "aborted" };

/**
 * Backtracking search for a feasible assignment within `budget` rows.
 * Items are visited in the given order and rows are tried ascending, so
 * the first solution found gives every item the lowest row that still
 * allows completion. `maxSteps` bounds the number of nodes explored;
 * the search reports "aborted" when the bound is hit.
 */
function searchAssignment(
  ordered: readonly TimelineItem[],
  overlap: readonly (readonly boolean[])[],
  budget: number,
  maxSteps: number
): SearchResult {
  const n = ordered.length;
  const assignment = new Array<number>(n).fill(-1);
  let stepsLeft = maxSteps;

  function fits(index: number, row: number): boolean {
    for (let j = 0; j < index; j++) {
      if (overlap[index]![j] && assignment[j] === row) return false;
    }
    return true;
  }

  function backtrack(index: number): boolean {
    if (stepsLeft-- <= 0) throw SearchAborted;
    if (index === n) return true;
    const item = ordered[index]!;
    if (item.fixedRow !== undefined) {
      const row = item.fixedRow!;
      if (row >= budget || !fits(index, row)) return false;
      assignment[index] = row;
      if (backtrack(index + 1)) return true;
      assignment[index] = -1;
      return false;
    }
    for (let row = 0; row < budget; row++) {
      if (!fits(index, row)) continue;
      assignment[index] = row;
      if (backtrack(index + 1)) return true;
      assignment[index] = -1;
    }
    return false;
  }

  try {
    return backtrack(0)
      ? { status: "found", assignment }
      : { status: "infeasible" };
  } catch (err) {
    if (err === SearchAborted) return { status: "aborted" };
    throw err;
  }
}

const SearchAborted = Symbol("SearchAborted");

/**
 * Lay out a batch of items on the minimum number of rows.
 *
 * The whole batch is rejected (FixedRowConflictError) when fixed requests
 * collide; nothing is assigned in that case.
 */
export interface LayoutOptions {
  /**
   * Maximum number of search nodes spent proving that fewer rows than the
   * greedy layout are impossible. When the budget is exhausted the greedy
   * (still valid, possibly non-minimal) layout is kept. Default 200000;
   * pass Infinity to always prove minimality.
   */
  maxSearchSteps?: number;
}

export function layoutTimeline(
  items: readonly TimelineItem[],
  previous?: PreviousLayout,
  options?: LayoutOptions
): LayoutResult {
  validateItems(items);

  const conflicts = findFixedConflicts(items);
  if (conflicts.length > 0) {
    throw new FixedRowConflictError(conflicts);
  }

  const rows = new Map<string, number>();
  const fixed: TimelineItem[] = [];
  const flexible: TimelineItem[] = [];
  for (const item of items) {
    (item.fixedRow !== undefined ? fixed : flexible).push(item);
  }

  // Fixed items are constraints: place them before anything flexible.
  const placed: TimelineItem[] = [];
  for (const item of fixed) {
    rows.set(item.id, item.fixedRow!);
    placed.push(item);
  }

  // Flexible items: (start, id) order, lowest free row wins.
  flexible.sort(compareByStartThenId);
  for (const item of flexible) {
    const blocked = new Set<number>();
    for (const other of placed) {
      if (overlaps(item, other)) blocked.add(rows.get(other.id)!);
    }
    let row = 0;
    while (blocked.has(row)) row++;
    rows.set(item.id, row);
    placed.push(item);
  }

  let rowCount = 0;
  for (const row of rows.values()) rowCount = Math.max(rowCount, row + 1);

  // Fixed rows can make the greedy pass exceed the true minimum. When the
  // greedy row count is not certified optimal, rearrange exactly: try
  // smaller budgets, keeping the (start, id) / lowest-row preference.
  const lowerBound = certifiedLowerBound(items);
  if (rowCount > lowerBound) {
    const maxSteps = options?.maxSearchSteps ?? 200_000;
    const ordered = [...items].sort(compareByStartThenId);
    const overlap = buildOverlapMatrix(ordered);
    for (let budget = lowerBound; budget < rowCount; budget++) {
      const result = searchAssignment(ordered, overlap, budget, maxSteps);
      if (result.status === "aborted") break;
      if (result.status === "found") {
        rows.clear();
        ordered.forEach((item, index) =>
          rows.set(item.id, result.assignment[index]!)
        );
        rowCount = budget;
        break;
      }
    }
  }

  const moves: MoveDelta[] = [];
  if (previous !== undefined) {
    const prev = normalizePrevious(previous);
    for (const [id, row] of rows) {
      if (!prev.has(id)) {
        moves.push({ id, from: null, to: row });
      } else if (prev.get(id) !== row) {
        moves.push({ id, from: prev.get(id)!, to: row });
      }
    }
    for (const [id, row] of prev) {
      if (!rows.has(id)) moves.push({ id, from: row, to: null });
    }
    moves.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  return { rowCount, rows, moves };
}

/**
 * Exact minimum number of rows for the given batch, found by exhaustive
 * backtracking over row budgets. Exponential in the number of items;
 * intended for small instances (e.g. verifying `layoutTimeline` in
 * tests). Throws the same errors as `layoutTimeline`.
 */
export function minRowsExhaustive(items: readonly TimelineItem[]): number {
  validateItems(items);
  const conflicts = findFixedConflicts(items);
  if (conflicts.length > 0) {
    throw new FixedRowConflictError(conflicts);
  }
  if (items.length === 0) return 0;

  const ordered = [...items].sort(compareByStartThenId);
  const overlap = buildOverlapMatrix(ordered);

  for (let budget = certifiedLowerBound(items); ; budget++) {
    const result = searchAssignment(ordered, overlap, budget, Infinity);
    if (result.status === "found") return budget;
  }
}
