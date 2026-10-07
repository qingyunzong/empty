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
export declare class FixedRowConflictError extends Error {
    readonly conflicts: FixedRowConflict[];
    constructor(conflicts: FixedRowConflict[]);
}
export declare function overlaps(a: Pick<TimelineItem, "start" | "end">, b: Pick<TimelineItem, "start" | "end">): boolean;
/** Conflicting pairs among fixed-row items sharing the same row. */
export declare function findFixedRowConflicts(items: readonly TimelineItem[]): FixedRowConflict[];
/**
 * Lay out a batch of items. Throws FixedRowConflictError (rejecting the
 * whole batch) if any fixed-row requests overlap on the same row.
 */
export declare function layout(items: readonly TimelineItem[]): LayoutResult;
/**
 * Re-layout a batch and report the move delta relative to a previous
 * assignment (a LayoutResult or a plain id -> row map).
 */
export declare function relayout(previous: LayoutResult | ReadonlyMap<string, number>, items: readonly TimelineItem[]): RelayoutResult;
/** Maximum number of intervals covering any single point. */
export declare function sweepDepth(items: readonly TimelineItem[]): number;
/**
 * Exact minimum row count by exhaustive search, honoring fixed rows.
 * Intended for verifying `layout` on small instances. Throws
 * FixedRowConflictError on unsatisfiable fixed requests.
 */
export declare function bruteForceMinRows(items: readonly TimelineItem[]): number;
