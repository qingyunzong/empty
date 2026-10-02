import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

function seedGraph(engine) {
  return engine.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'raw', content: 'raw-data-v1' },
      { op: 'upsert_file', id: 'meta', content: 'meta-v1' },
      { op: 'add_artifact', id: 'clean', builder: 'concat', edges: [{ id: 'src', target: 'raw' }] },
      { op: 'add_artifact', id: 'pack', builder: 'manifest', edges: [{ id: 'data', target: 'clean' }, { id: 'meta', target: 'meta' }] },
      { op: 'add_release', id: 'rel', edges: [{ id: 'main', target: 'pack' }] },
    ],
  });
}

test('initial build produces hashes, diff, invalidations and certificate', () => {
  const engine = new Engine();
  const result = seedGraph(engine);
  assert.equal(result.ok, true);
  assert.equal(result.txId, 't1');
  assert.deepEqual(result.diff.added, ['clean', 'meta', 'pack', 'raw', 'rel']);
  assert.deepEqual(result.diff.removed, []);
  assert.deepEqual(result.diff.changed, []);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.errors, []);
  for (const id of ['raw', 'meta', 'clean', 'pack', 'rel']) {
    assert.match(result.hashes[id], /^[0-9a-f]{64}$/);
  }
  // invalidations ordered by layer then id: files first, release last
  assert.deepEqual(result.invalidations.map((i) => i.id), ['meta', 'raw', 'clean', 'pack', 'rel']);
  assert.equal(result.certificates.length, 1);
  const cert = result.certificates[0];
  assert.equal(cert.release, 'rel');
  assert.equal(cert.txId, 't1');
  assert.equal(cert.blocked, false);
  assert.equal(cert.hash, result.hashes.rel);
  assert.deepEqual(cert.inputs, [{ edge: 'main', target: 'pack', hash: result.hashes.pack }]);
  assert.match(cert.digest, /^[0-9a-f]{64}$/);
});

test('artifact hash binds builder, input hashes and id-sorted edges', () => {
  const a = new Engine();
  a.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'f1', content: 'one' },
      { op: 'upsert_file', id: 'f2', content: 'two' },
      { op: 'add_artifact', id: 'x', builder: 'manifest', edges: [{ id: 'b', target: 'f2' }, { id: 'a', target: 'f1' }] },
    ],
  });
  const b = new Engine();
  b.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'f1', content: 'one' },
      { op: 'upsert_file', id: 'f2', content: 'two' },
      { op: 'add_artifact', id: 'x', builder: 'manifest', edges: [{ id: 'a', target: 'f1' }, { id: 'b', target: 'f2' }] },
    ],
  });
  // edge order in the declaration must not matter (sorted by edge id)
  assert.equal(a.state().hashes.x, b.state().hashes.x);
  // swapping edge ids changes the hash
  const c = new Engine();
  c.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'f1', content: 'one' },
      { op: 'upsert_file', id: 'f2', content: 'two' },
      { op: 'add_artifact', id: 'x', builder: 'manifest', edges: [{ id: 'a', target: 'f2' }, { id: 'b', target: 'f1' }] },
    ],
  });
  assert.notEqual(a.state().hashes.x, c.state().hashes.x);
  // different builder over same inputs changes the hash
  const d = new Engine();
  d.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'f1', content: 'one' },
      { op: 'upsert_file', id: 'f2', content: 'two' },
      { op: 'add_artifact', id: 'x', builder: 'concat', edges: [{ id: 'a', target: 'f1' }, { id: 'b', target: 'f2' }] },
    ],
  });
  assert.notEqual(a.state().hashes.x, d.state().hashes.x);
});

test('deep file correction only rebuilds the declared path', () => {
  const engine = new Engine();
  seedGraph(engine);
  const before = engine.state().hashes;
  const result = engine.transact({ id: 't2', ops: [{ op: 'upsert_file', id: 'raw', content: 'raw-data-v2' }] });
  assert.equal(result.ok, true);
  // only raw -> clean -> pack -> rel recomputed
  assert.deepEqual(result.invalidations.map((i) => i.id), ['raw', 'clean', 'pack', 'rel']);
  assert.equal(result.invalidations[0].reason, 'file-content-changed');
  assert.equal(result.invalidations[1].reason, 'input-changed:raw');
  assert.deepEqual(result.diff.changed.map((c) => c.id), ['clean', 'pack', 'raw', 'rel']);
  // unrelated file untouched
  assert.equal(result.hashes.meta, before.meta);
  assert.notEqual(result.hashes.clean, before.clean);
  assert.notEqual(result.hashes.rel, before.rel);
  // certificate refreshed
  assert.equal(result.certificates[0].hash, result.hashes.rel);
  assert.equal(result.certificates[0].txId, 't2');
});

test('no-op transaction yields empty diff and no recomputation', () => {
  const engine = new Engine();
  seedGraph(engine);
  const result = engine.transact({ id: 't2', ops: [{ op: 'upsert_file', id: 'raw', content: 'raw-data-v1' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.diff, { added: [], removed: [], changed: [], blocked: [] });
  assert.deepEqual(result.invalidations, []);
});

test('edge add/remove transactions invalidate the owning artifact', () => {
  const engine = new Engine();
  seedGraph(engine);
  const r1 = engine.transact({ id: 't2', ops: [{ op: 'add_edge', node: 'clean', edge: { id: 'extra', target: 'meta' } }] });
  assert.deepEqual(r1.invalidations.map((i) => i.id), ['clean', 'pack', 'rel']);
  assert.match(r1.invalidations[0].reason, /edge-added:extra/);
  const r2 = engine.transact({ id: 't3', ops: [{ op: 'remove_edge', node: 'clean', edgeId: 'extra' }] });
  assert.match(r2.invalidations[0].reason, /edge-removed:extra/);
  assert.equal(r2.hashes.clean, engine.state().hashes.clean);
});

test('unknown builder invalidates the artifact and blocks only its dependents', () => {
  const engine = new Engine();
  const result = engine.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'f1', content: 'x' },
      { op: 'add_artifact', id: 'bad', builder: 'does-not-exist', edges: [{ id: 'in', target: 'f1' }] },
      { op: 'add_artifact', id: 'good', builder: 'concat', edges: [{ id: 'in', target: 'f1' }] },
      { op: 'add_release', id: 'rel-blocked', edges: [{ id: 'main', target: 'bad' }] },
      { op: 'add_release', id: 'rel-fine', edges: [{ id: 'main', target: 'good' }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, [{ node: 'bad', code: 'E_BUILDER', message: 'unknown builder: does-not-exist' }]);
  assert.deepEqual(result.blocked, ['rel-blocked']);
  assert.equal(result.hashes.bad, null);
  assert.equal(result.hashes['rel-blocked'], null);
  assert.match(result.hashes['rel-fine'], /^[0-9a-f]{64}$/);
  const certs = Object.fromEntries(result.certificates.map((c) => [c.release, c]));
  assert.equal(certs['rel-blocked'].blocked, true);
  assert.equal(certs['rel-blocked'].hash, null);
  assert.equal(certs['rel-fine'].blocked, false);
});

test('missing edge target invalidates artifact with E_INPUT', () => {
  const engine = new Engine();
  const result = engine.transact({
    id: 't1',
    ops: [
      { op: 'upsert_file', id: 'f1', content: 'x' },
      { op: 'add_artifact', id: 'a1', builder: 'concat', edges: [{ id: 'in', target: 'ghost' }] },
      { op: 'add_release', id: 'r1', edges: [{ id: 'main', target: 'a1' }] },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, [{ node: 'a1', code: 'E_INPUT', message: "edge 'in' targets missing node 'ghost'" }]);
  assert.deepEqual(result.blocked, ['r1']);
});

test('removing a file invalidates downstream and diff reports removal', () => {
  const engine = new Engine();
  seedGraph(engine);
  const result = engine.transact({ id: 't2', ops: [{ op: 'remove_node', id: 'raw' }] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.diff.removed, ['raw']);
  assert.deepEqual(result.errors, [{ node: 'clean', code: 'E_INPUT', message: "edge 'src' targets missing node 'raw'" }]);
  assert.deepEqual(result.blocked, ['pack', 'rel']);
  assert.equal(result.hashes.raw, undefined);
  assert.equal(result.hashes.clean, null);
});

test('cycle in a transaction is rejected with E_CYCLE and state is untouched', () => {
  const engine = new Engine();
  seedGraph(engine);
  const before = engine.state();
  const result = engine.transact({
    id: 't2',
    ops: [
      { op: 'add_artifact', id: 'x', builder: 'concat', edges: [{ id: 'in', target: 'y' }] },
      { op: 'add_artifact', id: 'y', builder: 'concat', edges: [{ id: 'in', target: 'x' }] },
    ],
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_CYCLE');
  assert.deepEqual(result.error.nodes, ['x', 'y']);
  assert.deepEqual(engine.state(), before);
  // self loop
  const selfLoop = engine.transact({ id: 't3', ops: [{ op: 'add_edge', node: 'clean', edge: { id: 'loop', target: 'clean' } }] });
  assert.equal(selfLoop.ok, false);
  assert.equal(selfLoop.error.code, 'E_CYCLE');
  assert.deepEqual(engine.state(), before);
});

test('rollback restores hashes and graph structure; unknown tx errors', () => {
  const engine = new Engine();
  seedGraph(engine);
  const v1 = engine.state().hashes;
  engine.transact({ id: 't2', ops: [{ op: 'upsert_file', id: 'raw', content: 'raw-data-v2' }] });
  engine.transact({ id: 't3', ops: [{ op: 'remove_node', id: 'meta' }] });
  assert.notEqual(engine.state().hashes.raw, v1.raw);
  const back = engine.rollback('t2');
  assert.equal(back.ok, true);
  assert.equal(back.rolledBack, 't2');
  assert.deepEqual(back.discarded, ['t2', 't3']);
  assert.deepEqual(engine.state().hashes, v1);
  assert.deepEqual(back.diff.changed.map((c) => c.id), ['clean', 'pack', 'raw', 'rel']);
  // t2/t3 are gone from history
  assert.equal(engine.rollback('t2').error.code, 'E_TX_NOT_FOUND');
  assert.equal(engine.rollback('never-existed').error.code, 'E_TX_NOT_FOUND');
  // rolling back to the very first transaction empties the graph
  const toEmpty = engine.rollback('t1');
  assert.equal(toEmpty.ok, true);
  assert.deepEqual(engine.state().hashes, {});
  assert.equal(engine.rollback('t1').error.code, 'E_TX_NOT_FOUND');
});

test('empty build returns E_EMPTY', () => {
  const engine = new Engine();
  const result = engine.buildAll();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E_EMPTY');
  // a transaction that empties the graph also reports E_EMPTY
  seedGraph(engine);
  const emptied = engine.transact({
    id: 't2',
    ops: [
      { op: 'remove_node', id: 'rel' },
      { op: 'remove_node', id: 'pack' },
      { op: 'remove_node', id: 'clean' },
      { op: 'remove_node', id: 'raw' },
      { op: 'remove_node', id: 'meta' },
    ],
  });
  assert.equal(emptied.ok, false);
  assert.equal(emptied.error.code, 'E_EMPTY');
  // rollback still works after an emptied build
  assert.equal(engine.rollback('t2').ok, true);
  assert.match(engine.state().hashes.rel, /^[0-9a-f]{64}$/);
});

test('transaction validation errors: bad ops, duplicates, unknown op', () => {
  const engine = new Engine();
  assert.equal(engine.transact({ id: 't1', ops: [] }).error.code, 'E_TX_OPS');
  assert.equal(engine.transact({ id: 't1' }).error.code, 'E_TX_OPS');
  assert.equal(engine.transact({ id: 't1', ops: [{ op: 'teleport' }] }).error.code, 'E_OP');
  assert.equal(engine.transact({ id: 't1', ops: [{ op: 'add_edge', node: 'nope', edge: { id: 'e', target: 'x' } }] }).error.code, 'E_NODE');
  seedGraph(engine);
  assert.equal(engine.transact({ id: 't1', ops: [{ op: 'upsert_file', id: 'z', content: 'z' }] }).error.code, 'E_TX_ID');
});

test('buildAll recomputes everything and yields an empty diff when stable', () => {
  const engine = new Engine();
  seedGraph(engine);
  const result = engine.buildAll();
  assert.equal(result.ok, true);
  assert.deepEqual(result.diff, { added: [], removed: [], changed: [], blocked: [] });
  assert.deepEqual(result.invalidations.map((i) => i.id), ['meta', 'raw', 'clean', 'pack', 'rel']);
  assert.ok(result.invalidations.every((i) => i.reason === 'full-build'));
});
