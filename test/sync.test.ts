import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncBatch,
  type Item,
  type MergeDirectives,
  type SyncReport,
} from '../src/sync.js';
import { oracleSync } from './oracle.js';
import { mulberry32, randomSnapshot, editedCopy, cloneItems } from './random.js';

const item = (id: string, fields: Item['fields']): Item => ({ id, fields });

function canonical(items: readonly Item[] | null): string {
  if (items === null) return 'null';
  const sorted = items
    .map((it) => ({
      id: it.id,
      fields: Object.fromEntries(
        Object.keys(it.fields)
          .sort()
          .map((k) => [k, it.fields[k]]),
      ),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(sorted);
}

function canonicalConflicts(report: SyncReport): string {
  const sorted = [...report.unresolved].sort((a, b) =>
    a.itemId === b.itemId ? (a.field < b.field ? -1 : 1) : a.itemId < b.itemId ? -1 : 1,
  );
  return JSON.stringify(sorted);
}

function canonicalItemConflicts(report: SyncReport): string {
  return JSON.stringify(
    [...report.unresolvedItems].sort((a, b) => (a.itemId < b.itemId ? -1 : 1)),
  );
}

function actionsById(report: SyncReport): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of report.items) out[it.id] = it.action;
  return out;
}

function assertReportsMatch(actual: SyncReport, expected: SyncReport): void {
  assert.equal(actual.batchStatus, expected.batchStatus, 'batchStatus');
  assert.equal(actual.targetChanged, expected.targetChanged, 'targetChanged');
  assert.deepEqual(actionsById(actual), actionsById(expected), 'per-item actions');
  assert.equal(canonicalConflicts(actual), canonicalConflicts(expected), 'unresolved fields');
  assert.equal(canonicalItemConflicts(actual), canonicalItemConflicts(expected), 'unresolved items');
  assert.equal(canonical(actual.result), canonical(expected.result), 'result snapshot');
}

// ---------- Unit tests ----------

test('untouched target: batch applies wholesale, result equals source', () => {
  const base = [item('a', { x: 1 }), item('b', { y: 2 })];
  const source = [item('b', { y: 3 }), item('c', { z: 4 })];
  const report = syncBatch(base, source, cloneItems(base));
  assert.equal(report.batchStatus, 'applied');
  assert.equal(report.targetChanged, false);
  assert.equal(canonical(report.result), canonical(source));
  assert.deepEqual(actionsById(report), { a: 'removed', b: 'updated', c: 'added' });
  assert.deepEqual(report.unresolved, []);
});

test('any target change conflicts the whole batch; nothing is applied', () => {
  const base = [item('a', { x: 1 }), item('b', { y: 2 })];
  const source = [item('a', { x: 10 }), item('b', { y: 2 })];
  const target = [item('a', { x: 1 }), item('b', { y: 99 })]; // only b changed on target
  const report = syncBatch(base, source, target);
  assert.equal(report.batchStatus, 'conflict');
  assert.equal(report.targetChanged, true);
  assert.equal(report.result, null); // no partial per-item overwrite
  // Diagnostics still describe every differing item, including non-conflicting ones.
  assert.equal(report.items.length, 2);
});

test('merge disabled: field conflicts are diagnosed but not resolved', () => {
  const base = [item('a', { x: 1 })];
  const source = [item('a', { x: 2 })];
  const target = [item('a', { x: 3 })];
  const report = syncBatch(base, source, target);
  assert.equal(report.batchStatus, 'conflict');
  assert.equal(report.result, null);
  assert.deepEqual(report.unresolved, [
    { itemId: 'a', field: 'x', base: 1, source: 2, target: 3 },
  ]);
});

test('explicit merge: non-conflicting field edits merge automatically', () => {
  const base = [item('a', { x: 1, y: 1 })];
  const source = [item('a', { x: 2, y: 1 })]; // source changed x
  const target = [item('a', { x: 1, y: 9 })]; // target changed y
  const report = syncBatch(base, source, target, { merge: true });
  assert.equal(report.batchStatus, 'merged');
  assert.equal(canonical(report.result), canonical([item('a', { x: 2, y: 9 })]));
  const a = report.items.find((i) => i.id === 'a')!;
  assert.deepEqual(
    a.fields.map((f) => [f.field, f.origin, f.value]),
    [
      ['x', 'source', 2],
      ['y', 'target', 9],
    ],
  );
});

test('explicit merge: conflicting field needs a directive, then resolves', () => {
  const base = [item('a', { x: 1 })];
  const source = [item('a', { x: 2 })];
  const target = [item('a', { x: 3 })];

  const blocked = syncBatch(base, source, target, { merge: true });
  assert.equal(blocked.batchStatus, 'conflict');
  assert.equal(blocked.result, null);
  assert.equal(blocked.unresolved.length, 1);

  const directives: MergeDirectives = { fields: { a: { x: { pick: 'source' } } } };
  const resolved = syncBatch(base, source, target, { merge: true, directives });
  assert.equal(resolved.batchStatus, 'merged');
  assert.equal(canonical(resolved.result), canonical([item('a', { x: 2 })]));
  const field = resolved.items[0]!.fields[0]!;
  assert.equal(field.origin, 'resolved');
  assert.equal(field.value, 2);

  const overridden = syncBatch(base, source, target, {
    merge: true,
    directives: { fields: { a: { x: { value: 77 } } } },
  });
  assert.equal(canonical(overridden.result), canonical([item('a', { x: 77 })]));
});

test('delete-vs-modify is an item-level conflict resolved only by directive', () => {
  const base = [item('a', { x: 1 })];
  const source: Item[] = []; // source deleted a
  const target = [item('a', { x: 5 })]; // target modified a

  const blocked = syncBatch(base, source, target, { merge: true });
  assert.equal(blocked.batchStatus, 'conflict');
  assert.deepEqual(blocked.unresolvedItems, [
    { itemId: 'a', kind: 'delete-vs-modify', deletedBy: 'source' },
  ]);

  const keepTarget = syncBatch(base, source, target, {
    merge: true,
    directives: { items: { a: 'target' } },
  });
  assert.equal(keepTarget.batchStatus, 'merged');
  assert.equal(canonical(keepTarget.result), canonical([item('a', { x: 5 })]));

  const keepSource = syncBatch(base, source, target, {
    merge: true,
    directives: { items: { a: 'source' } },
  });
  assert.equal(keepSource.batchStatus, 'merged');
  assert.equal(canonical(keepSource.result), canonical([]));
});

test('duplicate ids are rejected', () => {
  const dup = [item('a', {}), item('a', {})];
  assert.throws(() => syncBatch(dup, [], []), /duplicate item id/);
  assert.throws(() => syncBatch([], dup, []), /duplicate item id/);
  assert.throws(() => syncBatch([], [], dup), /duplicate item id/);
});

// ---------- Property tests: random edits vs independent oracle ----------

test('property: untouched target always applies the source batch (500 trials)', () => {
  const rng = mulberry32(0x5eed);
  for (let trial = 0; trial < 500; trial++) {
    const base = randomSnapshot(rng, Math.floor(rng() * 6));
    const nextId = { value: base.length + 1 };
    const source = editedCopy(rng, base, Math.floor(rng() * 8), nextId);
    const target = cloneItems(base);
    const actual = syncBatch(base, source, target);
    const expected = oracleSync(base, source, target, false, {});
    assert.equal(actual.batchStatus, 'applied', `trial ${trial}`);
    assert.equal(canonical(actual.result), canonical(source), `trial ${trial}`);
    assertReportsMatch(actual, expected);
  }
});

test('property: random edits on both sides match the oracle (2000 trials)', () => {
  const rng = mulberry32(0xc0ffee);
  let conflicts = 0;
  let merges = 0;
  for (let trial = 0; trial < 2000; trial++) {
    const base = randomSnapshot(rng, Math.floor(rng() * 6));
    const nextId = { value: base.length + 1 };
    const source = editedCopy(rng, base, Math.floor(rng() * 6), nextId);
    const target = editedCopy(rng, base, Math.floor(rng() * 6), nextId);
    const merge = rng() < 0.5;

    const actual = syncBatch(base, source, target, { merge });
    const expected = oracleSync(base, source, target, merge, {});
    assertReportsMatch(actual, expected);
    if (actual.batchStatus === 'conflict') conflicts++;
    if (actual.batchStatus === 'merged') merges++;
  }
  // Sanity: the random distribution exercises both outcomes.
  assert.ok(conflicts > 0, 'expected some conflicted batches');
  assert.ok(merges > 0, 'expected some auto-merged batches');
});

test('property: directives resolving every conflict always merge (1000 trials)', () => {
  const rng = mulberry32(0xdec0de);
  for (let trial = 0; trial < 1000; trial++) {
    const base = randomSnapshot(rng, Math.floor(rng() * 6));
    const nextId = { value: base.length + 1 };
    const source = editedCopy(rng, base, Math.floor(rng() * 6), nextId);
    const target = editedCopy(rng, base, Math.floor(rng() * 6), nextId);

    const probe = syncBatch(base, source, target, { merge: true });
    if (probe.batchStatus !== 'conflict') continue;

    // Build directives that resolve every outstanding conflict, randomly
    // choosing a side (or an explicit value) per conflict.
    const directives: MergeDirectives = { fields: {}, items: {} };
    for (const c of probe.unresolved) {
      const roll = rng();
      const resolution =
        roll < 0.4 ? { pick: 'source' as const }
        : roll < 0.8 ? { pick: 'target' as const }
        : { value: (rng() < 0.5 ? 'forced' : 7) as string | number };
      (directives.fields![c.itemId] ??= {})[c.field] = resolution;
    }
    for (const c of probe.unresolvedItems) {
      directives.items![c.itemId] = rng() < 0.5 ? 'source' : 'target';
    }

    const actual = syncBatch(base, source, target, { merge: true, directives });
    const expected = oracleSync(base, source, target, true, directives);
    assert.equal(actual.batchStatus, 'merged', `trial ${trial}`);
    assertReportsMatch(actual, expected);
  }
});

test('property: no-merge mode never produces a result when target changed', () => {
  const rng = mulberry32(0xbad5eed);
  for (let trial = 0; trial < 500; trial++) {
    const base = randomSnapshot(rng, 1 + Math.floor(rng() * 5));
    const nextId = { value: base.length + 1 };
    const source = editedCopy(rng, base, 1 + Math.floor(rng() * 5), nextId);
    const target = editedCopy(rng, base, 1 + Math.floor(rng() * 5), nextId);
    const actual = syncBatch(base, source, target);
    const expected = oracleSync(base, source, target, false, {});
    assertReportsMatch(actual, expected);
    if (actual.targetChanged) {
      assert.equal(actual.batchStatus, 'conflict');
      assert.equal(actual.result, null);
    }
  }
});
