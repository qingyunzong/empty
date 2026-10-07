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

export type ErrorCode =
  | 'OUT_OF_BOUNDS'
  | 'INVALID_RECT'
  | 'MERGE_OVERLAP' // merge rect partially overlaps an existing merge
  | 'MERGE_CLIPPED' // copy source cuts through a merge
  | 'TARGET_MERGE_PARTIAL' // copy target touches but does not fully cover a merge
  | 'NOT_MERGED';

export interface OpError {
  code: ErrorCode;
  message: string;
  /** Index of the failing operation inside a batch. */
  index?: number;
}

export type Result = { ok: true } | { ok: false; error: OpError };

export type Operation<T = unknown> =
  | { type: 'set'; row: number; col: number; value: T }
  | { type: 'merge'; rect: Rect }
  | { type: 'split'; row: number; col: number }
  | { type: 'copy'; src: Rect; dstRow: number; dstCol: number };

const ok: Result = { ok: true };
const fail = (code: ErrorCode, message: string): Result => ({
  ok: false,
  error: { code, message },
});

function intersects(a: Rect, b: Rect): boolean {
  return (
    a.row < b.row + b.rows &&
    b.row < a.row + a.rows &&
    a.col < b.col + b.cols &&
    b.col < a.col + a.cols
  );
}

/** True when every cell of `inner` lies inside `outer`. */
function containsRect(outer: Rect, inner: Rect): boolean {
  return (
    inner.row >= outer.row &&
    inner.col >= outer.col &&
    inner.row + inner.rows <= outer.row + outer.rows &&
    inner.col + inner.cols <= outer.col + outer.cols
  );
}

export class TableGrid<T = unknown> {
  readonly rows: number;
  readonly cols: number;

  /** Value of each anchor cell; covered (non-anchor) cells stay undefined. */
  private values: (T | undefined)[][];
  /** Expanded model: anchor key "row:col" owning each position. */
  private owner: string[][];
  private merges: Merge[];

  constructor(rows: number, cols: number) {
    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
      throw new RangeError(`invalid grid size ${rows}x${cols}`);
    }
    this.rows = rows;
    this.cols = cols;
    this.values = Array.from({ length: rows }, () => Array<T | undefined>(cols).fill(undefined));
    this.owner = Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => TableGrid.key(r, c)),
    );
    this.merges = [];
  }

  private static key(row: number, col: number): string {
    return `${row}:${col}`;
  }

  private inBounds(row: number, col: number): boolean {
    return row >= 0 && row < this.rows && col >= 0 && col < this.cols;
  }

  private checkRect(rect: Rect): Result {
    const { row, col, rows, cols } = rect;
    if (
      !Number.isInteger(row) || !Number.isInteger(col) ||
      !Number.isInteger(rows) || !Number.isInteger(cols) ||
      rows < 1 || cols < 1
    ) {
      return fail('INVALID_RECT', `invalid rect ${JSON.stringify(rect)}`);
    }
    if (!this.inBounds(row, col) || !this.inBounds(row + rows - 1, col + cols - 1)) {
      return fail('OUT_OF_BOUNDS', `rect ${JSON.stringify(rect)} exceeds ${this.rows}x${this.cols} grid`);
    }
    return ok;
  }

  // ---------------------------------------------------------------- queries

  /** Anchor coordinates of the merge covering (row, col), or the cell itself. */
  anchorOf(row: number, col: number): { row: number; col: number } {
    if (!this.inBounds(row, col)) throw new RangeError(`cell (${row}, ${col}) out of bounds`);
    const [r, c] = (this.owner[row]![col]!).split(':').map(Number);
    return { row: r!, col: c! };
  }

  isMerged(row: number, col: number): boolean {
    const a = this.anchorOf(row, col);
    return a.row !== row || a.col !== col;
  }

  /** Logical value at (row, col): covered cells resolve to their anchor. */
  getValue(row: number, col: number): T | undefined {
    const a = this.anchorOf(row, col);
    return this.values[a.row]![a.col];
  }

  getMerges(): Merge[] {
    return this.merges.map((m) => ({ ...m }));
  }

  // ------------------------------------------------------------- mutations

  setValue(row: number, col: number, value: T): Result {
    if (!this.inBounds(row, col)) {
      return fail('OUT_OF_BOUNDS', `cell (${row}, ${col}) out of bounds`);
    }
    const a = this.anchorOf(row, col);
    this.values[a.row]![a.col] = value;
    return ok;
  }

  /**
   * Merge a rectangle into one cell anchored at its top-left corner.
   * Existing merges fully contained in the rect are absorbed; a rect that
   * cuts through an existing merge is rejected.
   */
  merge(rect: Rect): Result {
    const check = this.checkRect(rect);
    if (!check.ok) return check;
    if (rect.rows === 1 && rect.cols === 1) return ok; // degenerate: nothing to do

    for (const m of this.merges) {
      if (intersects(m, rect) && !containsRect(rect, m)) {
        return fail('MERGE_OVERLAP', `merge rect partially overlaps existing merge ${JSON.stringify(m)}`);
      }
    }

    const anchorValue = this.getValue(rect.row, rect.col);
    // Absorb contained merges, then rewrite ownership for the whole rect.
    this.merges = this.merges.filter((m) => !containsRect(rect, m));
    for (let r = rect.row; r < rect.row + rect.rows; r++) {
      for (let c = rect.col; c < rect.col + rect.cols; c++) {
        this.owner[r]![c] = TableGrid.key(rect.row, rect.col);
        this.values[r]![c] = undefined;
      }
    }
    this.values[rect.row]![rect.col] = anchorValue;
    this.merges.push({ ...rect });
    return ok;
  }

  /** Split the merge covering (row, col) back into individual cells. */
  split(row: number, col: number): Result {
    if (!this.inBounds(row, col)) {
      return fail('OUT_OF_BOUNDS', `cell (${row}, ${col}) out of bounds`);
    }
    const anchor = this.anchorOf(row, col);
    const idx = this.merges.findIndex((m) => m.row === anchor.row && m.col === anchor.col);
    if (idx === -1) {
      return fail('NOT_MERGED', `cell (${row}, ${col}) is not part of a merge`);
    }
    const m = this.merges[idx]!;
    this.merges.splice(idx, 1);
    for (let r = m.row; r < m.row + m.rows; r++) {
      for (let c = m.col; c < m.col + m.cols; c++) {
        this.owner[r]![c] = TableGrid.key(r, c);
        if (r !== m.row || c !== m.col) this.values[r]![c] = undefined;
      }
    }
    return ok;
  }

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
  copy(src: Rect, dstRow: number, dstCol: number): Result {
    const check = this.checkRect(src);
    if (!check.ok) return check;
    const dst: Rect = { row: dstRow, col: dstCol, rows: src.rows, cols: src.cols };
    const dstCheck = this.checkRect(dst);
    if (!dstCheck.ok) return dstCheck;

    for (const m of this.merges) {
      if (intersects(m, src) && !containsRect(src, m)) {
        return fail('MERGE_CLIPPED', `copy source clips merge ${JSON.stringify(m)}`);
      }
    }
    for (const m of this.merges) {
      if (intersects(m, dst) && !containsRect(dst, m)) {
        return fail('TARGET_MERGE_PARTIAL', `copy target partially covers merge ${JSON.stringify(m)}`);
      }
    }

    // Snapshot first: overlapping regions must read pre-copy state.
    const snapValues: (T | undefined)[][] = [];
    for (let r = 0; r < src.rows; r++) {
      const row: (T | undefined)[] = [];
      for (let c = 0; c < src.cols; c++) row.push(this.getValue(src.row + r, src.col + c));
      snapValues.push(row);
    }
    const snapMerges = this.merges
      .filter((m) => containsRect(src, m))
      .map((m) => ({ row: m.row - src.row, col: m.col - src.col, rows: m.rows, cols: m.cols }));

    // Clear the target: drop merges it fully covers, reset ownership/values.
    this.merges = this.merges.filter((m) => !containsRect(dst, m));
    for (let r = 0; r < dst.rows; r++) {
      for (let c = 0; c < dst.cols; c++) {
        const rr = dst.row + r;
        const cc = dst.col + c;
        this.owner[rr]![cc] = TableGrid.key(rr, cc);
        this.values[rr]![cc] = snapValues[r]![c];
      }
    }
    // Re-apply the copied merges at their offset positions.
    for (const m of snapMerges) {
      const anchorRow = dst.row + m.row;
      const anchorCol = dst.col + m.col;
      const anchorKey = TableGrid.key(anchorRow, anchorCol);
      const anchorValue = snapValues[m.row]![m.col];
      for (let r = anchorRow; r < anchorRow + m.rows; r++) {
        for (let c = anchorCol; c < anchorCol + m.cols; c++) {
          this.owner[r]![c] = anchorKey;
          this.values[r]![c] = undefined;
        }
      }
      this.values[anchorRow]![anchorCol] = anchorValue;
      this.merges.push({ row: anchorRow, col: anchorCol, rows: m.rows, cols: m.cols });
    }
    return ok;
  }

  /**
   * Apply operations atomically: they run against a private copy of the
   * model and are committed only when every operation succeeds. A failing
   * batch leaves the grid untouched.
   */
  applyBatch(ops: ReadonlyArray<Operation<T>>): Result {
    const draft = this.clone();
    for (let i = 0; i < ops.length; i++) {
      const r = draft.applyOne(ops[i]!);
      if (!r.ok) return { ok: false, error: { ...r.error, index: i } };
    }
    this.values = draft.values;
    this.owner = draft.owner;
    this.merges = draft.merges;
    return ok;
  }

  private applyOne(op: Operation<T>): Result {
    switch (op.type) {
      case 'set':
        return this.setValue(op.row, op.col, op.value);
      case 'merge':
        return this.merge(op.rect);
      case 'split':
        return this.split(op.row, op.col);
      case 'copy':
        return this.copy(op.src, op.dstRow, op.dstCol);
    }
  }

  private clone(): TableGrid<T> {
    const g = new TableGrid<T>(this.rows, this.cols);
    g.values = this.values.map((row) => row.slice());
    g.owner = this.owner.map((row) => row.slice());
    g.merges = this.merges.map((m) => ({ ...m }));
    return g;
  }

  // ------------------------------------------------- expanded-model checks

  /**
   * Verify the expanded-cell model is internally consistent.
   * Returns a list of violations; an empty list means the model is sound.
   */
  checkExpandedModel(): string[] {
    const problems: string[] = [];
    const seen = new Set<string>();

    if (this.values.length !== this.rows || this.owner.length !== this.rows) {
      problems.push('row count mismatch between model arrays');
    }

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const key = this.owner[r]?.[c];
        if (key === undefined) {
          problems.push(`missing owner at (${r}, ${c})`);
          continue;
        }
        const [ar, ac] = key.split(':').map(Number);
        if (ar === undefined || ac === undefined || !this.inBounds(ar, ac)) {
          problems.push(`owner of (${r}, ${c}) points out of bounds: ${key}`);
          continue;
        }
        if (this.owner[ar]![ac] !== key) {
          problems.push(`owner of (${r}, ${c}) is ${key} but that anchor does not own itself`);
        }
        const isAnchor = ar === r && ac === c;
        if (!isAnchor) {
          if (this.values[r]![c] !== undefined) {
            problems.push(`covered cell (${r}, ${c}) carries its own value`);
          }
          const covering = this.merges.some(
            (m) => r >= m.row && r < m.row + m.rows && c >= m.col && c < m.col + m.cols &&
              m.row === ar && m.col === ac,
          );
          if (!covering) problems.push(`covered cell (${r}, ${c}) has no matching merge record`);
        }
      }
    }

    for (const m of this.merges) {
      const k = TableGrid.key(m.row, m.col);
      if (seen.has(k)) problems.push(`duplicate merge anchored at ${k}`);
      seen.add(k);
      if (!this.checkRect(m).ok) {
        problems.push(`merge out of bounds: ${JSON.stringify(m)}`);
        continue;
      }
      for (let r = m.row; r < m.row + m.rows; r++) {
        for (let c = m.col; c < m.col + m.cols; c++) {
          if (this.owner[r]![c] !== k) {
            problems.push(`merge ${k} does not own cell (${r}, ${c})`);
          }
        }
      }
    }
    return problems;
  }
}
