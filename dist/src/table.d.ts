/**
 * table-grid-editor
 *
 * A table editing core built on an expanded-cell model:
 * every grid position owns a pointer to the anchor of the merge that covers
 * it (or to itself when unmerged), and values live only on anchor cells.
 * All mutations are validated against this model before they are applied,
 * so a rejected operation never leaves partial state behind.
 */
export interface Rect {
    row: number;
    col: number;
    rows: number;
    cols: number;
}
export type Merge = Rect;
export type ErrorCode = 'OUT_OF_BOUNDS' | 'INVALID_RECT' | 'MERGE_OVERLAP' | 'MERGE_CLIPPED' | 'TARGET_MERGE_PARTIAL' | 'NOT_MERGED';
export interface OpError {
    code: ErrorCode;
    message: string;
    /** Index of the failing operation inside a batch. */
    index?: number;
}
export type Result = {
    ok: true;
} | {
    ok: false;
    error: OpError;
};
export type Operation<T = unknown> = {
    type: 'set';
    row: number;
    col: number;
    value: T;
} | {
    type: 'merge';
    rect: Rect;
} | {
    type: 'split';
    row: number;
    col: number;
} | {
    type: 'copy';
    src: Rect;
    dstRow: number;
    dstCol: number;
};
export declare class TableGrid<T = unknown> {
    readonly rows: number;
    readonly cols: number;
    /** Value of each anchor cell; covered (non-anchor) cells stay undefined. */
    private values;
    /** Expanded model: anchor key "row:col" owning each position. */
    private owner;
    private merges;
    constructor(rows: number, cols: number);
    private static key;
    private inBounds;
    private checkRect;
    /** Anchor coordinates of the merge covering (row, col), or the cell itself. */
    anchorOf(row: number, col: number): {
        row: number;
        col: number;
    };
    isMerged(row: number, col: number): boolean;
    /** Logical value at (row, col): covered cells resolve to their anchor. */
    getValue(row: number, col: number): T | undefined;
    getMerges(): Merge[];
    setValue(row: number, col: number, value: T): Result;
    /**
     * Merge a rectangle into one cell anchored at its top-left corner.
     * Existing merges fully contained in the rect are absorbed; a rect that
     * cuts through an existing merge is rejected.
     */
    merge(rect: Rect): Result;
    /** Split the merge covering (row, col) back into individual cells. */
    split(row: number, col: number): Result;
    /**
     * Copy a rectangle to a new top-left position.
     *
     * - The source must not cut through a merge (every merge it touches must
     *   lie fully inside it), otherwise MERGE_CLIPPED.
     * - The target must fully cover every existing merge it touches,
     *   otherwise TARGET_MERGE_PARTIAL.
     * - The source is snapshotted before anything is written, so overlapping
     *   source/target regions copy the pre-copy state without pollution.
     */
    copy(src: Rect, dstRow: number, dstCol: number): Result;
    /**
     * Apply operations atomically: they run against a private copy of the
     * model and are committed only when every operation succeeds. A failing
     * batch leaves the grid untouched.
     */
    applyBatch(ops: ReadonlyArray<Operation<T>>): Result;
    private applyOne;
    private clone;
    /**
     * Verify the expanded-cell model is internally consistent.
     * Returns a list of violations; an empty list means the model is sound.
     */
    checkExpandedModel(): string[];
}
