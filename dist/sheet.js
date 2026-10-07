"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sheet = exports.SheetError = void 0;
exports.range = range;
exports.intersects = intersects;
exports.contains = contains;
class SheetError extends Error {
    constructor(message) {
        super(message);
        this.name = "SheetError";
    }
}
exports.SheetError = SheetError;
function range(row, col, rows, cols) {
    return { row, col, rows, cols };
}
function key(row, col) {
    return `${row},${col}`;
}
function assertValidRange(r, what) {
    if (!Number.isInteger(r.row) || !Number.isInteger(r.col) ||
        !Number.isInteger(r.rows) || !Number.isInteger(r.cols) ||
        r.row < 0 || r.col < 0 || r.rows < 1 || r.cols < 1) {
        throw new SheetError(`invalid ${what}: ${JSON.stringify(r)}`);
    }
}
function intersects(a, b) {
    return (a.row < b.row + b.rows && b.row < a.row + a.rows &&
        a.col < b.col + b.cols && b.col < a.col + a.cols);
}
/** True if `outer` fully contains `inner`. */
function contains(outer, inner) {
    return (inner.row >= outer.row && inner.col >= outer.col &&
        inner.row + inner.rows <= outer.row + outer.rows &&
        inner.col + inner.cols <= outer.col + outer.cols);
}
class Sheet {
    values = new Map();
    merges = [];
    // ---------- queries ----------
    /** Effective value at a cell: covered cells resolve to their merge anchor. */
    get(row, col) {
        const m = this.mergeAt(row, col);
        if (m)
            return this.values.get(key(m.row, m.col)) ?? null;
        return this.values.get(key(row, col)) ?? null;
    }
    /** Merge covering a cell, or undefined. */
    mergeAt(row, col) {
        return this.merges.find((m) => row >= m.row && row < m.row + m.rows && col >= m.col && col < m.col + m.cols);
    }
    getMerges() {
        return this.merges.map((m) => ({ ...m }));
    }
    /** Expanded-cell model: a dense grid of effective values. */
    expand(rows, cols) {
        const grid = [];
        for (let r = 0; r < rows; r++) {
            const line = [];
            for (let c = 0; c < cols; c++)
                line.push(this.get(r, c));
            grid.push(line);
        }
        return grid;
    }
    /** Structural invariant check used by tests and after batches. */
    assertConsistent() {
        for (let i = 0; i < this.merges.length; i++) {
            const a = this.merges[i];
            assertValidRange(a, "merge");
            if (a.rows === 1 && a.cols === 1) {
                throw new SheetError(`degenerate merge at ${key(a.row, a.col)}`);
            }
            for (let j = i + 1; j < this.merges.length; j++) {
                if (intersects(a, this.merges[j])) {
                    throw new SheetError(`overlapping merges at index ${i} and ${j}`);
                }
            }
            for (let r = a.row; r < a.row + a.rows; r++) {
                for (let c = a.col; c < a.col + a.cols; c++) {
                    if (r === a.row && c === a.col)
                        continue;
                    if (this.values.has(key(r, c))) {
                        throw new SheetError(`stray value under merge at ${key(r, c)}`);
                    }
                }
            }
        }
    }
    // ---------- mutations ----------
    /** Write a cell; writing anywhere inside a merge writes its anchor. */
    set(row, col, value) {
        const m = this.mergeAt(row, col);
        const k = m ? key(m.row, m.col) : key(row, col);
        if (value === null)
            this.values.delete(k);
        else
            this.values.set(k, value);
    }
    /**
     * Rectangular merge. Existing merges fully inside the range are absorbed;
     * a partial overlap with any existing merge is rejected.
     */
    merge(r) {
        assertValidRange(r, "merge range");
        if (r.rows === 1 && r.cols === 1) {
            throw new SheetError("cannot merge a single cell");
        }
        for (const m of this.merges) {
            if (intersects(m, r) && !contains(r, m)) {
                throw new SheetError(`merge ${fmt(r)} partially overlaps existing merge ${fmt(m)}`);
            }
        }
        const absorbed = this.merges.filter((m) => intersects(m, r));
        // Keep the top-left-most anchor value as the merged value.
        let kept = null;
        let found = false;
        for (let rr = r.row; rr < r.row + r.rows && !found; rr++) {
            for (let cc = r.col; cc < r.col + r.cols && !found; cc++) {
                const v = this.values.get(key(rr, cc));
                if (v !== undefined && v !== null) {
                    kept = v;
                    found = true;
                }
            }
        }
        this.merges = this.merges.filter((m) => !absorbed.includes(m));
        for (let rr = r.row; rr < r.row + r.rows; rr++) {
            for (let cc = r.col; cc < r.col + r.cols; cc++) {
                this.values.delete(key(rr, cc));
            }
        }
        if (kept !== null)
            this.values.set(key(r.row, r.col), kept);
        this.merges.push({ ...r });
    }
    /**
     * Split: remove every merge fully contained in the range. A merge only
     * partially inside the range is rejected (no partial splits).
     */
    unmerge(r) {
        assertValidRange(r, "unmerge range");
        for (const m of this.merges) {
            if (intersects(m, r) && !contains(r, m)) {
                throw new SheetError(`unmerge ${fmt(r)} clips existing merge ${fmt(m)}`);
            }
        }
        this.merges = this.merges.filter((m) => !contains(r, m));
    }
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
    copy(src, dstRow, dstCol) {
        assertValidRange(src, "copy source");
        const dst = { row: dstRow, col: dstCol, rows: src.rows, cols: src.cols };
        assertValidRange(dst, "copy destination");
        for (const m of this.merges) {
            if (intersects(m, src) && !contains(src, m)) {
                throw new SheetError(`copy source ${fmt(src)} clips merged cell ${fmt(m)}`);
            }
        }
        for (const m of this.merges) {
            if (intersects(m, dst) && !contains(dst, m)) {
                throw new SheetError(`copy destination ${fmt(dst)} partially covers merged cell ${fmt(m)}`);
            }
        }
        const snap = this.snapshot(src);
        // Clear destination: remove fully covered merges and all values inside.
        this.merges = this.merges.filter((m) => !contains(dst, m));
        for (let r = dst.row; r < dst.row + dst.rows; r++) {
            for (let c = dst.col; c < dst.col + dst.cols; c++) {
                this.values.delete(key(r, c));
            }
        }
        const covered = new Set();
        for (const m of snap.merges) {
            for (let r = m.row; r < m.row + m.rows; r++) {
                for (let c = m.col; c < m.col + m.cols; c++) {
                    if (r !== m.row || c !== m.col)
                        covered.add(key(r, c));
                }
            }
        }
        for (let r = 0; r < src.rows; r++) {
            for (let c = 0; c < src.cols; c++) {
                if (covered.has(key(r, c)))
                    continue; // merge anchors carry the value
                const v = snap.values[r][c];
                if (v !== null)
                    this.values.set(key(dst.row + r, dst.col + c), v);
            }
        }
        for (const m of snap.merges) {
            this.merges.push({
                row: dst.row + m.row,
                col: dst.col + m.col,
                rows: m.rows,
                cols: m.cols,
            });
        }
    }
    /**
     * Atomic batch: every op is applied to a working copy; the sheet is
     * modified only if all ops succeed. On any failure the sheet is untouched.
     */
    batch(ops) {
        const work = this.clone();
        for (const op of ops) {
            switch (op.type) {
                case "set":
                    work.set(op.row, op.col, op.value);
                    break;
                case "merge":
                    work.merge(op.range);
                    break;
                case "unmerge":
                    work.unmerge(op.range);
                    break;
                case "copy":
                    work.copy(op.src, op.dstRow, op.dstCol);
                    break;
                default:
                    throw new SheetError(`unknown op ${JSON.stringify(op)}`);
            }
        }
        work.assertConsistent();
        this.values = work.values;
        this.merges = work.merges;
    }
    clone() {
        const s = new Sheet();
        s.values = new Map(this.values);
        s.merges = this.merges.map((m) => ({ ...m }));
        return s;
    }
    // ---------- internals ----------
    snapshot(src) {
        const values = [];
        for (let r = 0; r < src.rows; r++) {
            const line = [];
            for (let c = 0; c < src.cols; c++) {
                line.push(this.get(src.row + r, src.col + c));
            }
            values.push(line);
        }
        const merges = this.merges
            .filter((m) => contains(src, m))
            .map((m) => ({
            row: m.row - src.row,
            col: m.col - src.col,
            rows: m.rows,
            cols: m.cols,
        }));
        return { values, merges };
    }
}
exports.Sheet = Sheet;
function fmt(r) {
    return `(${r.row},${r.col} ${r.rows}x${r.cols})`;
}
