import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'route-store-'));
  const store = Store.init(dir);
  return { dir, store };
}

const BASE_CHANGE = {
  addNodes: [
    { id: 's', op: 0, device: 'A', time: 5 },
    { id: 'm', op: 1, device: 'B', time: 3 },
    { id: 't', op: 2, device: 'A', time: 4 },
  ],
  addEdges: [
    ['s', 'm'],
    ['m', 't'],
    ['s', 't'],
  ],
};

// Builds genesis -> v1(BASE_CHANGE) and returns the store at v1.
function storeAtV1() {
  const { dir, store } = makeStore();
  const g = store.head();
  const { version: v1 } = store.commit({ base: g, readSet: [], change: BASE_CHANGE });
  return { dir, store, g, v1 };
}

test('init creates a deterministic genesis version', () => {
  const a = makeStore();
  const b = makeStore();
  assert.equal(a.store.head(), b.store.head());
});

test('two planners editing the same node: stable conflict certificate', () => {
  const run = () => {
    const { store, v1 } = storeAtV1();
    // Planner A occupies device A and touches node s.
    const { version: v2 } = store.commit({
      base: v1,
      readSet: ['s'],
      change: { occupy: { A: 10 }, removeEdges: [['s', 't']] },
    });
    // Planner B, still based on v1, also reads node s.
    let certificate = null;
    try {
      store.commit({
        base: v1,
        readSet: ['s', 'm'],
        change: { addEdges: [['s', 't']] },
      });
      assert.fail('expected E_CONFLICT');
    } catch (err) {
      assert.equal(err.code, 'E_CONFLICT');
      certificate = err.details.certificate;
    }
    return { certificate, v1, v2 };
  };

  const first = run();
  const second = run();
  // Certificate carries both version hashes, the read set and the common ancestor.
  assert.equal(first.certificate.code, 'E_CONFLICT');
  assert.equal(first.certificate.theirVersion, first.v2);
  assert.equal(first.certificate.commonAncestor, first.v1);
  assert.deepEqual(first.certificate.readSet, ['m', 's']);
  assert.deepEqual(first.certificate.conflicted, ['s']);
  assert.ok(first.certificate.ourVersion);
  // Deterministic hashing makes the certificate stable across identical runs.
  assert.deepEqual(second.certificate, first.certificate);
});

test('planners touching unrelated nodes commit sequentially', () => {
  const { store, v1 } = storeAtV1();
  const { version: v2 } = store.commit({
    base: v1,
    readSet: ['s'],
    change: { removeEdges: [['s', 't']] },
  });
  // Planner B based on the stale v1 but reading only unrelated node m.
  const { version: v3 } = store.commit({
    base: v1,
    readSet: ['m'],
    change: { occupy: { B: 7 } },
  });
  assert.equal(store.head(), v3);
  assert.notEqual(v3, v2);
  // v3 is rebased on v2: both changes are visible.
  const { graph } = store.loadVersion(v3);
  assert.ok(!graph.edges.get('s').has('t'), 'planner A edge removal preserved');
  assert.equal(graph.deviceLoad.get('B'), 7);
  const log = store.log();
  assert.deepEqual(
    log.map((e) => e.version),
    [v3, v2, v1, log[3].version],
  );
});

test('device occupancy conflicts via read set', () => {
  const { store, v1 } = storeAtV1();
  store.commit({ base: v1, readSet: [], change: { occupy: { A: 10 } } });
  assert.throws(
    () =>
      store.commit({
        base: v1,
        readSet: ['device:A'],
        change: { occupy: { A: 5 } },
      }),
    { code: 'E_CONFLICT' },
  );
});

test('corrupted chunk: common prefix stays queryable, full load fails', () => {
  const { store, v1 } = storeAtV1();
  const many = { addNodes: [], addEdges: [] };
  for (let i = 0; i < 12; i++) {
    many.addNodes.push({ id: `w${i}`, op: i, device: 'C', time: 1 });
    if (i > 0) many.addEdges.push([`w${i - 1}`, `w${i}`]);
  }
  const { version: v2 } = store.commit({ base: v1, readSet: [], change: many });

  // Damage a byte in the last chunk of the stored file.
  const file = store.pathOf(v2);
  const buf = Buffer.from(readFileSync(file));
  buf[buf.length - 2] = buf[buf.length - 2] ^ 0xff;
  writeFileSync(file, buf);

  const res = store.decodeVersion(v2);
  assert.equal(res.error.code, 'E_CORRUPT');
  assert.ok(res.chunksRead >= 1);
  assert.ok(res.chunksRead < res.chunkCount);
  // Prefix query: nodes decoded before the damaged chunk are available.
  assert.ok(res.graph.nodes.has('s'));
  assert.equal(res.graph.nodes.get('m').device, 'B');
  assert.throws(() => store.loadVersion(v2), { code: 'E_CORRUPT' });
});

test('unknown base version is rejected', () => {
  const { store } = storeAtV1();
  assert.throws(() => store.commit({ base: 'nope', readSet: [], change: {} }), {
    code: 'E_NOT_FOUND',
  });
});
