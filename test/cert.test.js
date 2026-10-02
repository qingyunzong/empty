'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, certificate, snapshot, minSupport } = require('../src/core');
const { replay } = require('../src/history');
const { mulberry32, randInt } = require('./helpers');

// Brute-force oracle: enumerate every subset of the currently active
// evidence, activate exactly that subset in a fresh store, and find the
// minimum (by size, then lexicographic) subset satisfying the claim.
function bruteForceMinSupport(claims, evidence, target) {
  const activeIds = Object.keys(evidence).filter((id) => evidence[id].active).sort();
  let best = null;
  const consider = (subset) => {
    if (best && subset.length > best.length) return;
    if (best && subset.length === best.length && subset.join('') >= best.join('')) return;
    const store = new Store();
    let clock = 0;
    for (const [id, ev] of Object.entries(evidence)) {
      store.applyOp({ clock: ++clock, agentId: 'oracle', op: 'addEvidence', id, weight: ev.weight, active: subset.includes(id) });
    }
    for (const c of claims) {
      store.applyOp({ clock: ++clock, agentId: 'oracle', op: 'addClaim', id: c.id, type: c.type, threshold: c.threshold, weight: c.weight });
      for (const ref of c.refs) store.applyOp({ clock: ++clock, agentId: 'oracle', op: 'addEdge', claim: c.id, ref });
    }
    store.settle();
    if (store.status.get(target).state === 'satisfied') best = subset;
  };
  const n = activeIds.length;
  for (let mask = 0; mask < 1 << n; mask += 1) {
    const subset = [];
    for (let i = 0; i < n; i += 1) if (mask & (1 << i)) subset.push(activeIds[i]);
    consider(subset);
  }
  return best;
}

// Build a random acyclic claim graph (<= 7 claims) over a small evidence pool.
function randomScenario(rng) {
  const nEvidence = randInt(rng, 1, 6);
  const nClaims = randInt(rng, 1, 7);
  const evidence = {};
  for (let i = 0; i < nEvidence; i += 1) {
    evidence[`e${i}`] = { weight: randInt(rng, 0, 4), active: rng() < 0.7 };
  }
  const claims = [];
  for (let i = 0; i < nClaims; i += 1) {
    const id = `c${i}`;
    const type = ['all', 'any', 'quorum'][randInt(rng, 0, 2)];
    const pool = [...Object.keys(evidence), ...claims.map((c) => c.id)]; // DAG: earlier only
    const nRefs = randInt(rng, 0, Math.min(3, pool.length));
    const refs = [];
    while (refs.length < nRefs) {
      const ref = pool[randInt(rng, 0, pool.length - 1)];
      if (!refs.includes(ref)) refs.push(ref);
    }
    claims.push({
      id,
      type,
      threshold: type === 'quorum' ? randInt(rng, 0, 5) : 0,
      weight: randInt(rng, 1, 3),
      refs,
    });
  }
  return { evidence, claims, target: `c${nClaims - 1}` };
}

function buildStore({ evidence, claims }) {
  const ops = [];
  let clock = 0;
  for (const [id, ev] of Object.entries(evidence)) {
    ops.push({ clock: ++clock, agentId: 'A', op: 'addEvidence', id, weight: ev.weight, active: ev.active });
  }
  for (const c of claims) {
    ops.push({ clock: ++clock, agentId: 'A', op: 'addClaim', id: c.id, type: c.type, threshold: c.threshold, weight: c.weight });
    for (const ref of c.refs) ops.push({ clock: ++clock, agentId: 'A', op: 'addEdge', claim: c.id, ref });
  }
  return replay(ops);
}

test('minimal support set matches brute-force enumeration (<=7 claims, 200 seeds)', () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const rng = mulberry32(seed);
    const scenario = randomScenario(rng);
    const store = buildStore(scenario);
    const cert = certificate(store, scenario.target);
    const expected = bruteForceMinSupport(scenario.claims, scenario.evidence, scenario.target);
    assert.deepEqual(
      cert.support,
      expected,
      `seed ${seed}: support ${JSON.stringify(cert.support)} != oracle ${JSON.stringify(expected)}`,
    );
    // certificate state must agree with satisfiability of the oracle
    const satisfied = expected !== null;
    assert.equal(cert.state === 'satisfied', satisfied, `seed ${seed} state mismatch`);
  }
});

test('certificate support actually satisfies and is inclusion-minimal', () => {
  const rng = mulberry32(999);
  for (let i = 0; i < 40; i += 1) {
    const scenario = randomScenario(rng);
    const store = buildStore(scenario);
    const cert = certificate(store, scenario.target);
    if (!cert.support) continue;
    const check = (dropId) => {
      const active = new Set(cert.support);
      if (dropId) active.delete(dropId);
      const s = buildStore({
        evidence: Object.fromEntries(
          Object.entries(scenario.evidence).map(([id, ev]) => [id, { ...ev, active: active.has(id) }]),
        ),
        claims: scenario.claims,
      });
      return s.status.get(scenario.target).state === 'satisfied';
    };
    assert.ok(check(null), 'support set must satisfy the claim');
    for (const id of cert.support) {
      assert.ok(!check(id), `removing ${id} must break satisfaction`);
    }
  }
});

test('certificate carries reason chain and matching state hash', () => {
  const store = replay([
    { clock: 1, agentId: 'A', op: 'addEvidence', id: 'e1', weight: 2 },
    { clock: 2, agentId: 'A', op: 'addEvidence', id: 'e2', weight: 3, active: false },
    { clock: 3, agentId: 'A', op: 'addClaim', id: 'c1', type: 'quorum', threshold: 5 },
    { clock: 4, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e1' },
    { clock: 5, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'e2' },
  ]);
  const cert = certificate(store, 'c1');
  assert.equal(cert.state, 'unsatisfied');
  assert.equal(cert.support, null);
  assert.deepEqual(cert.reasons[0], { claim: 'c1', rule: 'quorum', have: 2, need: 5 });
  assert.equal(cert.stateHash, snapshot(store).stateHash);
});

test('minSupport is null for claims in error states', () => {
  const store = replay([
    { clock: 1, agentId: 'A', op: 'addClaim', id: 'c1', type: 'all' },
    { clock: 2, agentId: 'A', op: 'addEdge', claim: 'c1', ref: 'c1' },
  ]);
  assert.equal(minSupport(store, 'c1'), null);
});
