import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { ReferenceEngine } from '../src/reference.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['f0', 'f1', 'f2', 'f3'];
const ARTIFACTS = ['a0', 'a1', 'a2', 'a3'];
const RELEASES = ['r0', 'r1'];
const ALL_IDS = [...FILES, ...ARTIFACTS, ...RELEASES]; // 10 nodes max
const KNOWN_BUILDERS = ['concat', 'first', 'count', 'xor', 'manifest'];

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];

function randomTarget(rnd) {
  return rnd() < 0.85 ? pick(rnd, ALL_IDS) : `ghost${Math.floor(rnd() * 3)}`;
}

function randomEdges(rnd) {
  const count = Math.floor(rnd() * 3); // 0..2 edges
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    edges.push({ id: `e${i}`, target: randomTarget(rnd) });
  }
  return edges;
}

function randomOps(rnd) {
  const count = 1 + Math.floor(rnd() * 3);
  const ops = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rnd();
    if (roll < 0.28) {
      ops.push({ op: 'upsert_file', id: pick(rnd, FILES), content: `v${Math.floor(rnd() * 4)}` });
    } else if (roll < 0.52) {
      ops.push({
        op: 'add_artifact',
        id: pick(rnd, ARTIFACTS),
        builder: rnd() < 0.12 ? 'bogus' : pick(rnd, KNOWN_BUILDERS),
        edges: randomEdges(rnd),
      });
    } else if (roll < 0.62) {
      ops.push({ op: 'add_release', id: pick(rnd, RELEASES), edges: randomEdges(rnd) });
    } else if (roll < 0.76) {
      ops.push({ op: 'add_edge', node: pick(rnd, [...ARTIFACTS, ...RELEASES]), edge: { id: `e${Math.floor(rnd() * 3)}`, target: randomTarget(rnd) } });
    } else if (roll < 0.86) {
      ops.push({ op: 'remove_edge', node: pick(rnd, [...ARTIFACTS, ...RELEASES]), edgeId: `e${Math.floor(rnd() * 3)}` });
    } else {
      ops.push({ op: 'remove_node', id: pick(rnd, ALL_IDS) });
    }
  }
  return ops;
}

function comparable(result) {
  if (!result.ok) return { ok: false, code: result.error.code };
  return {
    ok: true,
    diff: result.diff,
    blocked: result.blocked,
    hashes: result.hashes,
    errors: result.errors,
    certificates: result.certificates,
  };
}

function comparableRollback(result) {
  if (!result.ok) return { ok: false, code: result.error.code };
  return {
    ok: true,
    rolledBack: result.rolledBack,
    discarded: result.discarded,
    diff: result.diff,
    blocked: result.blocked,
    hashes: result.hashes,
  };
}

for (const seed of [1, 7, 42, 1337, 90210]) {
  test(`incremental engine matches full-rebuild reference (seed ${seed})`, () => {
    const rnd = mulberry32(seed);
    const engine = new Engine();
    const reference = new ReferenceEngine();
    const applied = [];
    for (let step = 0; step < 60; step += 1) {
      if (applied.length > 0 && rnd() < 0.12) {
        // rollback: usually to a real transaction, sometimes to a bogus id
        const txId = rnd() < 0.85 ? pick(rnd, applied) : 'no-such-tx';
        const actual = engine.rollback(txId);
        const expected = reference.rollback(txId);
        assert.deepEqual(comparableRollback(actual), comparableRollback(expected), `rollback ${txId} at step ${step}`);
        if (actual.ok) applied.length = applied.indexOf(txId);
        continue;
      }
      const txId = `tx-${step}`;
      const ops = randomOps(rnd);
      const actual = engine.transact({ id: txId, ops });
      const expected = reference.transact({ id: txId, ops });
      assert.deepEqual(comparable(actual), comparable(expected), `transaction ${txId} (seed ${seed})`);
      if (actual.ok) applied.push(txId);
      // periodic full-build self-check: incremental state must survive a full rebuild
      if (step % 7 === 3) {
        const full = engine.buildAll();
        if (full.ok) {
          assert.deepEqual(full.hashes, reference.state().hashes, `buildAll hashes at step ${step}`);
          assert.deepEqual(full.diff, { added: [], removed: [], changed: [], blocked: full.blocked }, `buildAll diff at step ${step}`);
        } else {
          assert.equal(full.error.code, 'E_EMPTY');
        }
      }
    }
  });
}

test('reference itself is deterministic across identical runs', () => {
  const run = () => {
    const rnd = mulberry32(99);
    const reference = new ReferenceEngine();
    const snapshots = [];
    for (let step = 0; step < 25; step += 1) {
      const result = reference.transact({ id: `tx-${step}`, ops: randomOps(rnd) });
      snapshots.push(result.ok ? result.hashes : result.error.code);
    }
    return snapshots;
  };
  assert.deepEqual(run(), run());
});
