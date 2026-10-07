import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedRowConflictError, bruteForceMinRows, layout, overlaps, relayout, sweepDepth, } from "../src/timeline.js";
const item = (id, start, end, fixedRow) => (fixedRow === undefined ? { id, start, end } : { id, start, end, fixedRow });
test("half-open semantics: touching intervals share a row, overlapping do not", () => {
    assert.equal(overlaps({ start: 0, end: 2 }, { start: 2, end: 5 }), false);
    assert.equal(overlaps({ start: 0, end: 2 }, { start: 1, end: 5 }), true);
    const { rows, rowCount } = layout([
        item("a", 0, 2),
        item("b", 2, 5),
        item("c", 1, 3),
    ]);
    assert.equal(rows.get("a"), 0);
    assert.equal(rows.get("b"), 0); // [2,5) fits right after [0,2)
    assert.equal(rows.get("c"), 1); // overlaps both
    assert.equal(rowCount, 2);
});
test("placement order: by start, then id; ties take the lowest free row", () => {
    const { rows } = layout([
        item("b", 0, 1),
        item("a", 0, 2),
        item("c", 1, 2),
    ]);
    // (0,"a") first -> row 0; (0,"b") next -> row 1; c fits under b on row 1.
    assert.equal(rows.get("a"), 0);
    assert.equal(rows.get("b"), 1);
    assert.equal(rows.get("c"), 1);
});
test("fixed rows are honored exactly, free items flow around them", () => {
    const { rows, rowCount } = layout([
        item("pinned", 1, 4, 2),
        item("a", 0, 2),
        item("b", 2, 3),
        item("c", 3, 5),
    ]);
    assert.equal(rows.get("pinned"), 2);
    assert.equal(rows.get("a"), 0);
    assert.equal(rows.get("b"), 0); // b starts at 2, a ends at 2
    assert.equal(rows.get("c"), 0); // c starts at 3... b ends at 3
    assert.equal(rowCount, 3);
});
test("fixed request can exceed the natural depth, raising the row count", () => {
    const { rows, rowCount } = layout([item("x", 0, 1, 4), item("y", 0, 1)]);
    assert.equal(rows.get("x"), 4);
    assert.equal(rows.get("y"), 0);
    assert.equal(rowCount, 5);
});
test("overlapping fixed requests on one row reject the whole batch", () => {
    assert.throws(() => layout([
        item("a", 0, 3, 1),
        item("b", 2, 5, 1),
        item("c", 10, 20),
    ]), (err) => {
        if (!(err instanceof FixedRowConflictError))
            return false;
        assert.deepEqual(err.conflicts, [{ row: 1, ids: ["a", "b"] }]);
        return true;
    });
    // Nothing is assigned: the batch is rejected as a whole (exception).
    assert.throws(() => bruteForceMinRows([item("a", 0, 3, 1), item("b", 2, 5, 1)]), FixedRowConflictError);
});
test("non-overlapping fixed requests may share a row", () => {
    const { rows, rowCount } = layout([
        item("a", 0, 2, 1),
        item("b", 2, 4, 1),
    ]);
    assert.equal(rows.get("a"), 1);
    assert.equal(rows.get("b"), 1);
    assert.equal(rowCount, 2);
});
test("relayout reports the move delta: added, moved, removed, kept", () => {
    const first = layout([item("a", 0, 2), item("b", 1, 3), item("c", 5, 6)]);
    assert.deepEqual([...first.rows.entries()].sort(), [
        ["a", 0],
        ["b", 1],
        ["c", 0],
    ]);
    const next = relayout(first, [
        item("a", 0, 2),
        item("b", 2, 3), // shifted: no longer overlaps a, fits on row 0
        item("d", 1, 2), // new, overlaps a
        // c removed
    ]);
    assert.deepEqual(next.moves, [
        { id: "b", from: 1, to: 0 },
        { id: "c", from: 0, to: null },
        { id: "d", from: null, to: 1 },
    ]);
    assert.equal(next.rows.get("a"), 0); // unchanged, not in moves
    assert.equal(next.rowCount, 2);
});
test("empty batch and validation errors", () => {
    assert.deepEqual(layout([]), { rowCount: 0, rows: new Map() });
    assert.throws(() => layout([item("x", 3, 3)]), /start < end/);
    assert.throws(() => layout([item("x", 4, 3)]), /start < end/);
    assert.throws(() => layout([item("x", 0, 1), item("x", 2, 3)]), /duplicate/);
    assert.throws(() => layout([item("x", 0, 1, -1)]), /fixedRow/);
    assert.throws(() => layout([item("x", 0, 1, 1.5)]), /fixedRow/);
});
test("sweep depth matches layout row count when nothing is pinned", () => {
    const items = [item("a", 0, 3), item("b", 1, 2), item("c", 1, 4), item("d", 4, 5)];
    assert.equal(sweepDepth(items), 3);
    assert.equal(layout(items).rowCount, 3);
});
test("exhaustive: greedy row count equals brute-force minimum (grid 0..4, 3 items)", () => {
    const spans = [];
    for (let s = 0; s < 4; s++) {
        for (let e = s + 1; e <= 4; e++)
            spans.push([s, e]);
    }
    let checked = 0;
    for (const [s1, e1] of spans) {
        for (const [s2, e2] of spans) {
            for (const [s3, e3] of spans) {
                const items = [
                    item("i0", s1, e1),
                    item("i1", s2, e2),
                    item("i2", s3, e3),
                ];
                assert.equal(layout(items).rowCount, bruteForceMinRows(items), `mismatch for ${JSON.stringify(items)}`);
                checked++;
            }
        }
    }
    assert.equal(checked, spans.length ** 3);
});
test("randomized: greedy equals brute-force minimum with fixed rows (seeded)", () => {
    // Deterministic xorshift so failures reproduce.
    let state = 0x9e3779b9;
    const rand = (n) => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return Math.abs(state) % n;
    };
    for (let trial = 0; trial < 500; trial++) {
        const n = 1 + rand(5);
        const items = [];
        for (let i = 0; i < n; i++) {
            const start = rand(6);
            const end = start + 1 + rand(4);
            const pinned = rand(3) === 0;
            items.push(pinned ? item(`t${trial}i${i}`, start, end, rand(4)) : item(`t${trial}i${i}`, start, end));
        }
        let greedy;
        let exact;
        try {
            greedy = layout(items).rowCount;
            exact = bruteForceMinRows(items);
        }
        catch (err) {
            assert.ok(err instanceof FixedRowConflictError);
            continue; // infeasible batches are rejected by both paths
        }
        assert.equal(greedy, exact, `mismatch for ${JSON.stringify(items)}`);
    }
});
