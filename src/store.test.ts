import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  RelationStore,
  Version,
  applyDiff,
  diff,
  invert,
  verifyReverse,
  type Edge,
} from './store';

const e = (id: string, from: string, to: string, label: string): Edge => ({ id, from, to, label });

test('batch commit adds, removes and relabels edges', () => {
  const store = new RelationStore();
  const v1 = store.commit([
    { kind: 'add', edge: e('e1', 'a', 'b', 'knows') },
    { kind: 'add', edge: e('e2', 'b', 'c', 'likes') },
  ]);
  assert.equal(v1.size, 2);

  const v2 = store.commit([
    { kind: 'relabel', id: 'e1', label: 'follows' },
    { kind: 'remove', id: 'e2' },
    { kind: 'add', edge: e('e3', 'c', 'a', 'blocks') },
  ]);
  assert.equal(v2.size, 2);
  assert.deepEqual(v2.get('e1'), e('e1', 'a', 'b', 'follows'));
  assert.equal(v2.get('e2'), undefined);
  assert.deepEqual(v2.get('e3'), e('e3', 'c', 'a', 'blocks'));
});

test('cycles and self-loops are allowed', () => {
  const store = new RelationStore();
  const v = store.commit([
    { kind: 'add', edge: e('loop', 'n', 'n', 'self') },
    { kind: 'add', edge: e('c1', 'x', 'y', 'ab') },
    { kind: 'add', edge: e('c2', 'y', 'x', 'ba') },
  ]);
  assert.equal(v.size, 3);
  assert.deepEqual(v.get('loop'), e('loop', 'n', 'n', 'self'));
});

test('same endpoints with different ids are not merged', () => {
  const store = new RelationStore();
  store.commit([
    { kind: 'add', edge: e('p1', 'a', 'b', 'L1') },
    { kind: 'add', edge: e('p2', 'a', 'b', 'L2') },
    { kind: 'add', edge: e('p3', 'a', 'b', 'L1') },
  ]);
  assert.equal(store.version.size, 3);

  const before = store.version;
  const after = store.commit([{ kind: 'remove', id: 'p2' }]);
  const d = diff(before, after);
  assert.equal(d.added.length, 0);
  assert.equal(d.relabeled.length, 0);
  assert.deepEqual(d.removed, [e('p2', 'a', 'b', 'L2')]);
  assert.equal(after.size, 2);
  assert.ok(after.has('p1'));
  assert.ok(after.has('p3'));
});

test('batches are atomic: a failing op discards the whole batch', () => {
  const store = new RelationStore();
  store.commit([{ kind: 'add', edge: e('e1', 'a', 'b', 'x') }]);
  const before = store.version;

  assert.throws(
    () =>
      store.commit([
        { kind: 'add', edge: e('e2', 'b', 'c', 'y') },
        { kind: 'remove', id: 'missing' },
      ]),
    /batch rejected: cannot remove unknown edge missing/,
  );
  assert.equal(store.version, before, 'store must keep the exact previous version');
  assert.equal(store.version.has('e2'), false);

  assert.throws(
    () =>
      store.commit([
        { kind: 'add', edge: e('dup', 'a', 'b', '1') },
        { kind: 'add', edge: e('dup', 'c', 'd', '2') },
      ]),
    /duplicate edge id dup/,
  );
  assert.equal(store.version, before);

  assert.throws(
    () => store.commit([{ kind: 'add', edge: e('e1', 'a', 'c', 'z') }]),
    /duplicate edge id e1/,
  );
  assert.equal(store.version, before);
});

test('diff reports added, removed and relabeled edges', () => {
  const store = new RelationStore();
  const v1 = store.commit([
    { kind: 'add', edge: e('keep', 'a', 'b', 'same') },
    { kind: 'add', edge: e('gone', 'b', 'c', 'old') },
    { kind: 'add', edge: e('swap', 'c', 'd', 'before') },
  ]);
  const v2 = store.commit([
    { kind: 'remove', id: 'gone' },
    { kind: 'relabel', id: 'swap', label: 'after' },
    { kind: 'add', edge: e('fresh', 'd', 'e', 'new') },
  ]);

  const d = diff(v1, v2);
  assert.deepEqual(d.added, [e('fresh', 'd', 'e', 'new')]);
  assert.deepEqual(d.removed, [e('gone', 'b', 'c', 'old')]);
  assert.equal(d.relabeled.length, 1);
  assert.equal(d.relabeled[0]!.id, 'swap');
  assert.deepEqual(d.relabeled[0]!.from, e('swap', 'c', 'd', 'before'));
  assert.deepEqual(d.relabeled[0]!.to, e('swap', 'c', 'd', 'after'));

  assert.deepEqual(diff(v1, v1), { added: [], removed: [], relabeled: [] });
});

test('reverse diff restores the previous version exactly', () => {
  const store = new RelationStore();
  const v1 = store.commit([
    { kind: 'add', edge: e('e1', 'a', 'a', 'loop') },
    { kind: 'add', edge: e('e2', 'a', 'b', 'x') },
    { kind: 'add', edge: e('e3', 'a', 'b', 'x') },
  ]);
  const v2 = store.commit([
    { kind: 'relabel', id: 'e2', label: 'y' },
    { kind: 'remove', id: 'e3' },
    { kind: 'add', edge: e('e4', 'b', 'a', 'z') },
  ]);

  assert.ok(verifyReverse(v1, v2));

  const forward = diff(v1, v2);
  const backward = invert(forward);
  assert.deepEqual(backward.added, forward.removed);
  assert.deepEqual(backward.removed, forward.added);
  const restored = applyDiff(v2, backward);
  assert.ok(restored.equals(v1));
  assert.ok(applyDiff(v1, forward).equals(v2), 'forward diff reaches the target');
});

test('applyDiff validates content and rejects stale diffs', () => {
  const store = new RelationStore();
  const v1 = store.commit([{ kind: 'add', edge: e('e1', 'a', 'b', 'x') }]);
  const v2 = store.commit([{ kind: 'relabel', id: 'e1', label: 'y' }]);
  const d = diff(v1, v2);

  assert.throws(() => applyDiff(v2, d), /does not match version/);
  assert.throws(
    () => applyDiff(v1, { added: [e('e1', 'a', 'b', 'x')], removed: [], relabeled: [] }),
    /already exists/,
  );
});

test('versions are immutable snapshots', () => {
  const store = new RelationStore();
  const v1 = store.commit([{ kind: 'add', edge: e('e1', 'a', 'b', 'x') }]);
  store.commit([{ kind: 'remove', id: 'e1' }]);
  assert.equal(v1.size, 1, 'earlier version is unaffected by later commits');
  assert.ok(v1.equals(new Version(new Map([['e1', e('e1', 'a', 'b', 'x')]]))));
});
