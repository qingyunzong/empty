/**
 * Sheet: a sparse table model with rectangular merges, split (unmerge),
 * and cross-region copy.
 *
 * Invariants:
 *  - Merges are non-overlapping rectangles.
 *  - A value is stored only at a merge's anchor (top-left) cell; covered
 *    cells never hold their own entries.
 *  - copy() reads a snapshot of the source before mutating, so overlapping
 *    source/destination never pollutes the result.
 *  - Every mutating op validates fully before applying; batch() applies all
 *    ops on a working copy and commits only if every op succeeds.
 */
export type CellValue = string | number | boolean | null;
export interface Range {
    row: number;
    col: number;
    rows: number;
    cols: number;
}
export declare class SheetError extends Error {
    constructor(message: string);
}
export declare function range(row: number, col: number, rows: number, cols: number): Range;
export declare function intersects(a: Range, b: Range): boolean;
/** True if `outer` fully contains `inner`. */
export declare function contains(outer: Range, inner: Range): boolean;
export type Operation = {
    type: "set";
    row: number;
    col: number;
    value: CellValue;
} | {
    type: "merge";
    range: Range;
} | {
    type: "unmerge";
    range: Range;
} | {
    type: "copy";
    src: Range;
    dstRow: number;
    dstCol: number;
};
export declare class Sheet {
    private values;
    private merges;
    /** Effective value at a cell: covered cells resolve to their merge anchor. */
    get(row: number, col: number): CellValue;
    /** Merge covering a cell, or undefined. */
    mergeAt(row: number, col: number): Range | undefined;
    getMerges(): Range[];
    /** Expanded-cell model: a dense grid of effective values. */
    expand(rows: number, cols: number): CellValue[][];
    /** Structural invariant check used by tests and after batches. */
    assertConsistent(): void;
    /** Write a cell; writing anywhere inside a merge writes its anchor. */
    set(row: number, col: number, value: CellValue): void;
    /**
     * Rectangular merge. Existing merges fully inside the range are absorbed;
     * a partial overlap with any existing merge is rejected.
     */
    merge(r: Range): void;
    /**
     * Split: remove every merge fully contained in the range. A merge only
     * partially inside the range is rejected (no partial splits).
     */
    unmerge(r: Range): void;
    /**
     * Cross-region copy of `src` to a same-sized rectangle anchored at
     * (dstRow, dstCol).
     *
     *  - The source must not clip any merge: every merge touching `src` must
     *    be fully inside it.
     *  - The destination must fully cover any old merge it touches.
     *  - The source is snapshotted before any mutation, so overlapping
     *    source/destination copies behave as if read from the original.
     */
    copy(src: Range, dstRow: number, dstCol: number): void;
    /**
     * Atomic batch: every op is applied to a working copy; the sheet is
     * modified only if all ops succeed. On any failure the sheet is untouched.
     */
    batch(ops: Operation[]): void;
    clone(): Sheet;
    private snapshot;
}
