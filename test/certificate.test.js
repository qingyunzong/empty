import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { totalOrder } from '../src/order.js';
import { certificate } from '../src/certificate.js';
import {
  mulberry32,
  randInt,
  evalClaim,
  bruteForceMinimalSupport,
  snapshotToPlain,
} from './helpers.js';

// Acceptance 1: with <= 7 claims, the certificate's minimal support set must
// match brute-force enumeration of all evidence subsets.

function randomAcyclicScenario(rand) {
  const nEvidence = randInt(rand, 2, 6);
  const nClaims = randInt(rand, 1, 7);
  const ops = [];
  let clock = 0;
  const push = (op) => ops.push({ clock: ++clock, agentId: clock % 2 ? 'alice' : 'bob', ...op });

  const evIds = [];
  for (let i = 0; i < nEvidence; i++) {
    const id = `e${i}`;
    evIds.push(id);
    push({ op: 'addEvidence', id, weight: randInt(rand, 1, 5) });
    if (rand() < 0.2) push({ op: 'retractEvidence', id });
  }
  const claimIds = [];
  for (let i = 0; i < nClaims; i++) {
    const id = `c${i}`;
    claimIds.push(id);
    const type = ['all', 'any', 'quorum'][randInt(rand, 0, 2)];
    const def = { op: 'defineClaim', id, type };
    if (type === 'quorum') def.threshold = randInt(rand, 0, 6);
    if (rand() < 0.3) def.weight = randInt(rand, 1, 3);
    push(def);
    // refs only to evidence or earlier claims: acyclic by construction
    const pool = [...evIds, ...claimIds.slice(0, i)];
    const nRefs = randInt(rand, 0, Math.min(4, pool.length));
    const chosen = new Set();
    for (let r = 0; r < nRefs; r++) {
      const ref = pool[randInt(rand, 0, pool.length - 1)];
      if (chosen.has(ref)) continue;
      chosen.add(ref);
      push({ op: 'addEdge', claim: id, ref });
      if (rand() < 0.1) push({ op: 'addEdge', claim: id, ref }); // idempotent re-add
    }
  }
  return { ops, claimIds };
}

test('minimal support matches exhaustive evidence-subset enumeration (<=7 claims)', () => {
  let checked = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const rand = mulberry32(seed);
    const { ops, claimIds } = randomAcyclicScenario(rand);
    const engine = new Engine().applyAll(totalOrder(ops));
    const snap = engine.snapshot();
    const { evidence, claims } = snapshotToPlain(snap);
    for (const id of claimIds) {
      const st = engine.statusOf(id);
      if (st.error || !st.satisfied) continue;
      const cert = certificate(engine, id);
      const expected = bruteForceMinimalSupport(evidence, claims, id);
      assert.deepEqual(
        cert.minimalSupport,
        expected,
        `seed ${seed} claim ${id}: ${JSON.stringify(cert.minimalSupport)} != ${JSON.stringify(expected)}`
      );
      // minimality: removing any single element must break satisfaction
      const activeIds = Object.keys(evidence).filter((e) => evidence[e].active);
      for (const x of cert.minimalSupport) {
        const reduced = new Set(cert.minimalSupport.filter((y) => y !== x));
        const still = evalClaim(evidence, claims, id, reduced);
        assert.equal(still.satisfied, false, `seed ${seed} claim ${id}: ${x} was not needed`);
      }
      // support only references currently-active evidence
      for (const x of cert.minimalSupport) assert.ok(activeIds.includes(x));
      checked++;
    }
  }
  assert.ok(checked > 150, `too few satisfied claims exercised: ${checked}`);
});

test('certificate carries state hash and rejection reason chain', () => {
  const engine = new Engine().applyAll([
    { clock: 1, agentId: 'a', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'a', op: 'addEvidence', id: 'e2', weight: 3 },
    { clock: 3, agentId: 'a', op: 'retractEvidence', id: 'e2' },
    { clock: 4, agentId: 'a', op: 'defineClaim', id: 'inner', type: 'all' },
    { clock: 5, agentId: 'a', op: 'addEdge', claim: 'inner', ref: 'e2' },
    { clock: 6, agentId: 'a', op: 'defineClaim', id: 'outer', type: 'quorum', threshold: 5 },
    { clock: 7, agentId: 'a', op: 'addEdge', claim: 'outer', ref: 'e1' },
    { clock: 8, agentId: 'a', op: 'addEdge', claim: 'outer', ref: 'inner' },
  ]);
  const cert = certificate(engine, 'outer');
  assert.equal(cert.satisfied, false);
  assert.equal(cert.error, null);
  assert.equal(cert.stateHash, engine.stateHash());
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
  const root = cert.reasons[0];
  assert.equal(root.code, 'E_QUORUM');
  assert.deepEqual(root.detail, { achieved: 2, threshold: 5 });
  const innerReason = root.children.find((c) => c.node === 'inner');
  assert.equal(innerReason.code, 'E_ALL');
  assert.ok(innerReason.children.some((c) => c.node === 'e2' && c.code === 'E_INACTIVE'));
});

test('certificate is reproducible: same history, same bytes', () => {
  const ops = [
    { clock: 1, agentId: 'a', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'b', op: 'defineClaim', id: 'c', type: 'all' },
    { clock: 3, agentId: 'a', op: 'addEdge', claim: 'c', ref: 'e1' },
  ];
  const c1 = certificate(new Engine().applyAll(totalOrder(ops)), 'c');
  const c2 = certificate(new Engine().applyAll(totalOrder([...ops].reverse())), 'c');
  assert.deepEqual(c1, c2);
});
