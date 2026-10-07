import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TableGrid, type Operation } from '../src/table.js';

function assertSound<T>(g: TableGrid<T>) {
  assert.deepEqual(g.checkExpandedModel(), [], 'expanded-cell model must stay consistent');
}

/** Fill a grid so cell (r, c) holds `r * 100 + c`. */
function numbered(rows: number, cols: number): TableGrid<number> {
  const g = new TableGrid<number>(rows, cols);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) g.setValue(r, c, r * 100 + c);
  return g;
}

test('merge: rectangle becomes one logical cell anchored top-left', () => {
  const g = numbered(4, 4);
  assert.equal(g.merge({ row: 1, col: 1, rows: 2, cols: 2 }).ok, true);
  assert.equal(g.isMerged(2, 2), true);
  assert.deepEqual(g.anchorOf(2, 2), { row: 1, col: 1 });
  assert.equal(g.getValue(2, 2), 101); // covered cell resolves to anchor value
  assert.deepEqual(g.getMerges(), [{ row: 1, col: 1, rows: 2, cols: 2 }]);
  assertSound(g);
});

test('merge: partial overlap with an existing merge is rejected, state untouched', () => {
  const g = numbered(4, 4);
  g.merge({ row: 0, col: 0, rows: 2, cols: 2 });
  const r = g.merge({ row: 1, col: 1, rows: 2, cols: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error.code, 'MERGE_OVERLAP');
  assert.deepEqual(g.getMerges(), [{ row: 0, col: 0, rows: 2, cols: 2 }]);
  assertSound(g);
});

test('merge: fully containing an existing merge absorbs it', () => {
  const g = numbered(4, 4);
  g.merge({ row: 1, col: 1, rows: 1, cols: 2 });
  assert.equal(g.merge({ row: 0, col: 0, rows: 3, cols: 3 }).ok, true);
  assert.deepEqual(g.getMerges(), [{ row: 0, col: 0, rows: 3, cols: 3 }]);
  assert.equal(g.getValue(2, 2), 0); // new anchor value wins
  assertSound(g);
});

test('split: restores individual cells, anchor keeps its value', () => {
  const g = numbered(3, 3);
  g.merge({ row: 0, col: 0, rows: 2, cols: 3 });
  assert.equal(g.split(1, 2).ok, true); // any covered cell targets the merge
  assert.deepEqual(g.getMerges(), []);
  assert.equal(g.getValue(0, 0), 0);
  assert.equal(g.getValue(1, 2), undefined); // covered cells come back empty
  assertSound(g);
});

test('split: unmerged cell is rejected', () => {
  const g = numbered(2, 2);
  const r = g.split(0, 0);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error.code, 'NOT_MERGED');
  assertSound(g);
});

test('copy: values and merges replicate to a disjoint region', () => {
  const g = numbered(4, 6);
  g.merge({ row: 0, col: 1, rows: 2, cols: 2 });
  assert.equal(g.copy({ row: 0, col: 0, rows: 2, cols: 3 }, 2, 3).ok, true);
  assert.equal(g.getValue(2, 3), 0);
  assert.equal(g.getValue(3, 5), 1); // copied merge anchor value
  assert.deepEqual(g.anchorOf(3, 5), { row: 2, col: 4 });
  assert.deepEqual(g.getMerges(), [
    { row: 0, col: 1, rows: 2, cols: 2 },
    { row: 2, col: 4, rows: 2, cols: 2 },
  ]);
  assertSound(g);
});

test('copy: source clipping part of a merge is rejected, nothing changes', () => {
  const g = numbered(4, 4);
  g.merge({ row: 1, col: 1, rows: 2, cols: 2 });
  const before = g.getMerges();
  const r = g.copy({ row: 0, col: 0, rows: 2, cols: 2 }, 2, 0); // cuts the merge in half
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error.code, 'MERGE_CLIPPED');
  assert.deepEqual(g.getMerges(), before);
  assert.equal(g.getValue(2, 0), 200);
  assertSound(g);
});

test('copy: target touching an old merge must fully cover it', () => {
  const g = numbered(4, 4);
  g.merge({ row: 2, col: 2, rows: 2, cols: 2 });
  const r = g.copy({ row: 0, col: 0, rows: 2, cols: 2 }, 2, 1); // overlaps half the merge
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error.code, 'TARGET_MERGE_PARTIAL');
  assert.equal(g.getValue(2, 2), 202); // merge value intact
  assertSound(g);
});

test('copy: target fully covering an old merge replaces it', () => {
  const g = numbered(6, 6);
  g.merge({ row: 3, col: 3, rows: 2, cols: 2 });
  assert.equal(g.copy({ row: 0, col: 0, rows: 3, cols: 3 }, 2, 2).ok, true);
  assert.deepEqual(g.getMerges(), []);
  assert.equal(g.getValue(3, 3), 101); // plain copied value, no merge left
  assertSound(g);
});

test('copy: overlapping source/target reads a snapshot, no pollution', () => {
  const g = new TableGrid<number>(5, 1);
  for (let r = 0; r < 5; r++) g.setValue(r, 0, r + 1); // 1,2,3,4,5
  assert.equal(g.copy({ row: 0, col: 0, rows: 3, cols: 1 }, 1, 0).ok, true);
  const col = [0, 1, 2, 3, 4].map((r) => g.getValue(r, 0));
  assert.deepEqual(col, [1, 1, 2, 3, 5]); // not [1,1,1,1,5]
  assertSound(g);
});

test('copy: overlapping region carrying a merge stays consistent', () => {
  const g = numbered(6, 4);
  g.merge({ row: 2, col: 0, rows: 2, cols: 2 });
  // Source rows 0-3, target rows 1-4: regions overlap; the target fully
  // covers the old merge and the copied merge lands at rows 3-4.
  assert.equal(g.copy({ row: 0, col: 0, rows: 4, cols: 2 }, 1, 0).ok, true);
  assert.deepEqual(g.getMerges(), [{ row: 3, col: 0, rows: 2, cols: 2 }]);
  assert.equal(g.getValue(4, 1), 200); // moved merge keeps its anchor value
  assert.equal(g.getValue(2, 0), 100); // vacated cell gets plain copied value
  assert.equal(g.getValue(0, 0), 0); // outside target: untouched
  assertSound(g);
});

test('copy: merge only in the source is duplicated, original kept', () => {
  const g = numbered(6, 4);
  g.merge({ row: 0, col: 0, rows: 2, cols: 2 });
  assert.equal(g.copy({ row: 0, col: 0, rows: 4, cols: 2 }, 2, 0).ok, true);
  assert.deepEqual(g.getMerges(), [
    { row: 0, col: 0, rows: 2, cols: 2 },
    { row: 2, col: 0, rows: 2, cols: 2 },
  ]);
  assert.equal(g.getValue(1, 1), 0); // still covered by the original merge
  assert.equal(g.getValue(3, 1), 0); // covered by the copied merge
  assertSound(g);
});

test('copy: out-of-bounds source or target is rejected', () => {
  const g = numbered(3, 3);
  assert.equal(g.copy({ row: 2, col: 2, rows: 2, cols: 1 }, 0, 0).ok, false);
  assert.equal(g.copy({ row: 0, col: 0, rows: 2, cols: 2 }, 2, 2).ok, false);
  assertSound(g);
});

test('batch: all operations apply when every one is valid', () => {
  const g = numbered(4, 4);
  const ops: Operation<number>[] = [
    { type: 'merge', rect: { row: 0, col: 0, rows: 2, cols: 2 } },
    { type: 'set', row: 0, col: 0, value: 999 },
    { type: 'copy', src: { row: 0, col: 0, rows: 2, cols: 2 }, dstRow: 2, dstCol: 2 },
  ];
  assert.equal(g.applyBatch(ops).ok, true);
  assert.equal(g.getValue(3, 3), 999);
  assert.deepEqual(g.getMerges(), [
    { row: 0, col: 0, rows: 2, cols: 2 },
    { row: 2, col: 2, rows: 2, cols: 2 },
  ]);
  assertSound(g);
});

test('batch: one failure rolls back everything and reports the index', () => {
  const g = numbered(4, 4);
  g.merge({ row: 2, col: 2, rows: 2, cols: 2 });
  const ops: Operation<number>[] = [
    { type: 'set', row: 0, col: 0, value: 42 },
    { type: 'merge', rect: { row: 0, col: 0, rows: 2, cols: 2 } },
    { type: 'copy', src: { row: 0, col: 0, rows: 2, cols: 2 }, dstRow: 2, dstCol: 1 }, // hits old merge partially
  ];
  const r = g.applyBatch(ops);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error.code, 'TARGET_MERGE_PARTIAL');
  assert.equal(r.ok === false && r.error.index, 2);
  // No modification leaked through.
  assert.equal(g.getValue(0, 0), 0);
  assert.deepEqual(g.getMerges(), [{ row: 2, col: 2, rows: 2, cols: 2 }]);
  assertSound(g);
});

test('setValue: writing through a covered cell updates the anchor', () => {
  const g = numbered(3, 3);
  g.merge({ row: 0, col: 0, rows: 2, cols: 2 });
  assert.equal(g.setValue(1, 1, 7).ok, true);
  assert.equal(g.getValue(0, 0), 7);
  assert.equal(g.setValue(9, 9, 1).ok, false);
  assertSound(g);
});
