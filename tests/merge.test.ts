import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETE,
  merge,
  mergeAll,
  mergeNodes,
  materialize,
  isTombstone,
  type ProvenanceEntry,
} from '../src/merge.js';

// ---------- object recursive merge ----------

test('objects merge recursively, scalars override', () => {
  const { value } = merge(
    { a: 1, b: { c: 2, d: 3 } },
    { b: { c: 20 }, e: 4 },
  );
  assert.deepEqual(value, { a: 1, b: { c: 20, d: 3 }, e: 4 });
});

test('inputs are never mutated', () => {
  const base = { a: { b: 1 }, list: [{ id: 'x', v: 1 }] };
  const over = { a: { c: 2 }, list: [{ id: 'x', w: 2 }] };
  const baseSnap = JSON.parse(JSON.stringify(base));
  const overSnap = JSON.parse(JSON.stringify(over));
  merge(base, over);
  assert.deepEqual(base, baseSnap);
  assert.deepEqual(over, overSnap);
});

// ---------- type change -> whole-item replacement ----------

test('type change replaces the whole subtree (object -> scalar)', () => {
  const { value } = merge({ a: { x: 1, y: 2 } }, { a: 5 });
  assert.deepEqual(value, { a: 5 });
});

test('type change replaces the whole subtree (scalar -> object)', () => {
  const { value } = merge({ a: 5 }, { a: { x: 1 } });
  assert.deepEqual(value, { a: { x: 1 } });
});

test('type change replaces the whole subtree (object -> array)', () => {
  const { value } = merge({ a: { x: 1 } }, { a: [1, 2] });
  assert.deepEqual(value, { a: [1, 2] });
});

test('null is a scalar value and replaces objects', () => {
  const { value } = merge({ a: { x: 1 } }, { a: null });
  assert.deepEqual(value, { a: null });
});

// ---------- arrays merge by stable id ----------

test('array elements with the same id merge recursively, order preserved', () => {
  const { value } = merge(
    { servers: [{ id: 'a', host: 'x', port: 1 }, { id: 'b', port: 2 }] },
    { servers: [{ id: 'b', port: 22, tls: true }, { id: 'a', host: 'y' }] },
  );
  assert.deepEqual(value, {
    servers: [
      { id: 'a', host: 'y', port: 1 },
      { id: 'b', port: 22, tls: true },
    ],
  });
});

test('array elements with new ids append in override order', () => {
  const { value } = merge(
    { list: [{ id: 'a', v: 1 }] },
    { list: [{ id: 'c', v: 3 }, { id: 'b', v: 2 }] },
  );
  assert.deepEqual(value, { list: [{ id: 'a', v: 1 }, { id: 'c', v: 3 }, { id: 'b', v: 2 }] });
});

test('unkeyed array elements append', () => {
  const { value } = merge({ list: [1, 2] }, { list: [3] });
  assert.deepEqual(value, { list: [1, 2, 3] });
});

test('custom idKey is honored', () => {
  const { value } = merge(
    { items: [{ name: 'a', v: 1 }] },
    { items: [{ name: 'a', w: 2 }] },
    { idKey: 'name' },
  );
  assert.deepEqual(value, { items: [{ name: 'a', v: 1, w: 2 }] });
});

// ---------- explicit deletion & tombstones ----------

test('DELETE symbol removes an existing key', () => {
  const { value } = merge({ a: 1, b: 2 }, { a: DELETE });
  assert.deepEqual(value, { b: 2 });
});

test('{ $delete: true } marker removes an existing key', () => {
  const { value } = merge({ a: 1, b: 2 }, { a: { $delete: true } });
  assert.deepEqual(value, { b: 2 });
});

test('deleting a non-existent key keeps a tombstone that shadows ancestors', () => {
  // user layer deletes "legacy" which the user layer's own base does not have
  const userMerged = mergeNodes({ other: 1 }, { legacy: DELETE });
  const internal = userMerged as Record<string, unknown>;
  assert.ok(isTombstone(internal.legacy), 'tombstone kept in internal node');
  // later the merged result is applied over an ancestor base that HAS "legacy"
  const final = materialize(mergeNodes({ legacy: 'old', other: 0 }, userMerged));
  assert.deepEqual(final, { other: 1 });
});

test('array element delete by id', () => {
  const { value } = merge(
    { list: [{ id: 'a', v: 1 }, { id: 'b', v: 2 }] },
    { list: [{ id: 'a', $delete: true }] },
  );
  assert.deepEqual(value, { list: [{ id: 'b', v: 2 }] });
});

test('array delete of non-existent id keeps tombstone and shadows ancestor', () => {
  const userMerged = mergeNodes({ list: [{ id: 'a', v: 1 }] }, { list: [{ id: 'z', $delete: true }] });
  const final = materialize(
    mergeNodes({ list: [{ id: 'z', v: 99 }, { id: 'a', v: 0 }] }, userMerged),
  );
  assert.deepEqual(final, { list: [{ id: 'a', v: 1 }] });
});

test('re-adding after delete resurrects the item', () => {
  const { value } = mergeAll([
    { list: [{ id: 'a', v: 1 }] },
    { list: [{ id: 'a', $delete: true }] },
    { list: [{ id: 'a', v: 2 }] },
  ]);
  assert.deepEqual(value, { list: [{ id: 'a', v: 2 }] });
});

test('array delete marker without id throws', () => {
  assert.throws(() => merge({ list: [1] }, { list: [{ $delete: true }] }), /stable id/);
});

// ---------- provenance ----------

function provMap(report: ProvenanceEntry[]): Map<string, ProvenanceEntry> {
  return new Map(report.map((e) => [e.path, e]));
}

test('provenance reports the decisive layer and rule per item', () => {
  const { report } = mergeAll([
    { a: 1, b: { c: 2 }, list: [{ id: 'x', v: 1 }] },
    { b: { c: 20 }, list: [{ id: 'x', w: 2 }, { id: 'y', v: 3 }] },
  ]);
  const m = provMap(report);
  assert.equal(m.get('a')!.source, 0);
  assert.equal(m.get('a')!.rule, 'add');
  assert.equal(m.get('b.c')!.source, 1);
  assert.equal(m.get('b.c')!.rule, 'override');
  assert.equal(m.get('list[id="x"].v')!.source, 0);
  assert.equal(m.get('list[id="x"].w')!.source, 1);
  assert.equal(m.get('list[id="x"]')!.rule, 'id-merge');
  assert.equal(m.get('list[id="y"]')!.rule, 'append');
  assert.equal(m.get('list[id="y"].v')!.source, 1);
});

test('provenance records type-replace and delete', () => {
  const { report, tombstones } = mergeAll([
    { a: { x: 1 }, gone: 1, ghost: 1 },
    { a: 5, gone: DELETE },
    { ghost: DELETE },
  ]);
  const m = provMap(report);
  assert.equal(m.get('a')!.rule, 'type-replace');
  assert.equal(m.get('a')!.source, 1);
  const t = new Map(tombstones.map((e) => [e.path, e]));
  assert.equal(t.get('gone')!.rule, 'delete');
  assert.equal(t.get('gone')!.source, 1);
  // layer 2 deletes "ghost" which no longer exists (already deleted? no: still present) -> delete
  assert.equal(t.get('ghost')!.rule, 'delete');
});

test('tombstone rule used when deleting a non-existent item', () => {
  const { tombstones, value } = mergeAll([{ a: 1 }, { missing: DELETE }]);
  assert.deepEqual(value, { a: 1 });
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].rule, 'tombstone');
  assert.equal(tombstones[0].path, 'missing');
});

// ---------- three-layer merge vs direct rule application ----------

const L0 = {
  server: { host: '0.0.0.0', port: 8080, tls: { enabled: false } },
  features: { legacy: true },
  tags: ['base'],
  servers: [
    { id: 'web', replicas: 1, env: { DEBUG: 'false' } },
    { id: 'db', engine: 'pg', port: 5432 },
    { id: 'cache', ttl: 300 },
  ],
  limits: { cpu: '1', mem: '1Gi' },
};

const L1 = {
  server: { port: 9090, tls: { enabled: true, cert: '/etc/cert' } },
  features: { legacy: DELETE },
  tags: ['env'],
  servers: [
    { id: 'db', port: 5433 },
    { id: 'cache', $delete: true },
    { id: 'queue', workers: 2 },
  ],
  limits: 'unlimited', // type change: object -> scalar
};

const L2 = {
  server: { host: '127.0.0.1' },
  features: { experimental: true },
  servers: [{ id: 'web', replicas: 3 }, { id: 'ghost', $delete: true }],
};

const EXPECTED = {
  server: { host: '127.0.0.1', port: 9090, tls: { enabled: true, cert: '/etc/cert' } },
  features: { experimental: true },
  tags: ['base', 'env'],
  servers: [
    { id: 'web', replicas: 3, env: { DEBUG: 'false' } },
    { id: 'db', engine: 'pg', port: 5433 },
    { id: 'queue', workers: 2 },
  ],
  limits: 'unlimited',
};

test('three-layer merge produces the expected config', () => {
  const { value } = mergeAll([L0, L1, L2]);
  assert.deepEqual(value, EXPECTED);
});

test('sequential fold equals one-shot mergeAll (associativity)', () => {
  const oneShot = materialize(mergeNodes(mergeNodes(mergeNodes(undefined, L0), L1), L2));
  const leftFold = materialize(mergeNodes(mergeNodes(L0, L1), L2));
  const rightFold = materialize(mergeNodes(L0, mergeNodes(L1, L2)));
  const all = mergeAll([L0, L1, L2]).value;
  assert.deepEqual(leftFold, EXPECTED);
  assert.deepEqual(rightFold, EXPECTED);
  assert.deepEqual(oneShot, EXPECTED);
  assert.deepEqual(all, EXPECTED);
});

test('tombstone for never-existent array id survives three-layer merge', () => {
  const { tombstones } = mergeAll([L0, L1, L2]);
  const ghost = tombstones.find((t) => t.path === 'servers[id="ghost"]');
  assert.ok(ghost, 'ghost tombstone recorded');
  assert.equal(ghost.rule, 'tombstone');
  assert.equal(ghost.source, 2);
  const cache = tombstones.find((t) => t.path === 'servers[id="cache"]');
  assert.ok(cache, 'cache delete recorded');
  assert.equal(cache.rule, 'delete');
  assert.equal(cache.source, 1);
});
