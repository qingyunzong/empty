import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RelationStore,
  StoreError,
  applyDelta,
  invertDelta,
  snapshotsEqual,
  type Edge,
} from '../src/store.ts';

const e = (id: string, from: string, to: string, label: string): Edge => ({ id, from, to, label });

test('diff reports added, removed and relabeled edges', () => {
  const s = new RelationStore();
  const v0 = s.current;
  const v1 = s.commit([
    { type: 'add', edge: e('e1', 'a', 'b', 'knows') },
    { type: 'add', edge: e('e2', 'b', 'c', 'likes') },
  ]);
  const v2 = s.commit([
    { type: 'relabel', id: 'e1', label: 'follows' },
    { type: 'remove', id: 'e2' },
    { type: 'add', edge: e('e3', 'c', 'a', 'blocks') },
  ]);

  const d = s.diff(v1, v2);
  assert.deepEqual(d.added, [e('e3', 'c', 'a', 'blocks')]);
  assert.deepEqual(d.removed, [e('e2', 'b', 'c', 'likes')]);
  assert.deepEqual(d.relabeled, [
    { id: 'e1', from: 'a', to: 'b', oldLabel: 'knows', newLabel: 'follows' },
  ]);

  const dAll = s.diff(v0, v2);
  assert.equal(dAll.added.length, 2);
  assert.equal(dAll.removed.length, 0);
  assert.equal(dAll.relabeled.length, 0);
});

test('parallel edges with same endpoints and different ids are not merged', () => {
  const s = new RelationStore();
  s.commit([
    { type: 'add', edge: e('p1', 'x', 'y', 'L') },
    { type: 'add', edge: e('p2', 'x', 'y', 'L') },
    { type: 'add', edge: e('p3', 'x', 'y', 'L') },
  ]);
  assert.equal(s.snapshot().size, 3);

  const v1 = s.current;
  const v2 = s.commit([{ type: 'relabel', id: 'p2', label: 'M' }]);
  const d = s.diff(v1, v2);
  assert.equal(d.relabeled.length, 1);
  assert.deepEqual(d.relabeled[0], { id: 'p2', from: 'x', to: 'y', oldLabel: 'L', newLabel: 'M' });
  assert.equal(s.snapshot(v2).size, 3);

  const v3 = s.commit([{ type: 'remove', id: 'p1' }]);
  assert.equal(s.snapshot(v3).size, 2);
  const d2 = s.diff(v2, v3);
  assert.deepEqual(d2.removed, [e('p1', 'x', 'y', 'L')]);
});

test('self-loops and cycles are allowed', () => {
  const s = new RelationStore();
  s.commit([
    { type: 'add', edge: e('loop', 'n', 'n', 'self') },
    { type: 'add', edge: e('c1', 'a', 'b', 'ab') },
    { type: 'add', edge: e('c2', 'b', 'a', 'ba') },
  ]);
  const snap = s.snapshot();
  assert.equal(snap.get('loop')?.from, snap.get('loop')?.to);
  assert.equal(snap.size, 3);
});

test('batch is atomic: one invalid op rejects the whole batch', () => {
  const s = new RelationStore();
  const v1 = s.commit([{ type: 'add', edge: e('e1', 'a', 'b', 'L') }]);
  const before = s.snapshot();

  assert.throws(
    () =>
      s.commit([
        { type: 'add', edge: e('e2', 'b', 'c', 'L') },
        { type: 'remove', id: 'missing' },
      ]),
    StoreError,
  );
  assert.equal(s.current, v1);
  assert.ok(snapshotsEqual(s.snapshot(), before));

  assert.throws(
    () =>
      s.commit([
        { type: 'add', edge: e('e3', 'a', 'a', 'L') },
        { type: 'add', edge: e('e3', 'x', 'y', 'L') },
      ]),
    StoreError,
  );
  assert.equal(s.current, v1);
  assert.ok(snapshotsEqual(s.snapshot(), before));

  assert.throws(() => s.commit([{ type: 'relabel', id: 'nope', label: 'x' }]), StoreError);
  assert.equal(s.current, v1);
});

test('empty batch still commits a new version', () => {
  const s = new RelationStore();
  const v1 = s.commit([]);
  assert.equal(v1, 1);
  assert.ok(snapshotsEqual(s.snapshot(0), s.snapshot(1)));
});

test('endpoint change on same id is remove + add, not relabel', () => {
  const s = new RelationStore();
  const v1 = s.commit([{ type: 'add', edge: e('e1', 'a', 'b', 'L') }]);
  const v2 = s.commit([
    { type: 'remove', id: 'e1' },
    { type: 'add', edge: e('e1', 'a', 'c', 'L') },
  ]);
  const d = s.diff(v1, v2);
  assert.equal(d.relabeled.length, 0);
  assert.deepEqual(d.removed, [e('e1', 'a', 'b', 'L')]);
  assert.deepEqual(d.added, [e('e1', 'a', 'c', 'L')]);
});

test('inverse diff applied to the later image restores the earlier one', () => {
  const s = new RelationStore();
  const v1 = s.commit([
    { type: 'add', edge: e('e1', 'a', 'b', 'x') },
    { type: 'add', edge: e('e2', 'b', 'b', 'y') },
    { type: 'add', edge: e('e3', 'c', 'a', 'z') },
  ]);
  const v2 = s.commit([
    { type: 'relabel', id: 'e2', label: 'y2' },
    { type: 'remove', id: 'e3' },
    { type: 'add', edge: e('e4', 'a', 'a', 'w') },
  ]);

  assert.ok(s.validateInverse(v1, v2));
  assert.ok(s.validateInverse(0, v2));
  assert.ok(s.validateInverse(0, v1));

  const forward = s.diff(v1, v2);
  const applied = applyDelta(s.snapshot(v1), forward);
  assert.ok(snapshotsEqual(applied, s.snapshot(v2)));

  const restored = applyDelta(s.snapshot(v2), invertDelta(forward));
  assert.ok(snapshotsEqual(restored, s.snapshot(v1)));
});

test('unknown version raises StoreError', () => {
  const s = new RelationStore();
  assert.throws(() => s.snapshot(7), StoreError);
  assert.throws(() => s.diff(0, 3), StoreError);
});
