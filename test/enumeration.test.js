'use strict';
// Acceptance 4: for derivation graphs with n <= 8, cross-check the two closure
// implementations against each other and the verify engine against a naive
// brute-force reference, over an enumerated space of seeded DAGs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { closureBFS, closureFixpoint } = require('../src/closure');
const { foldEvents } = require('../src/state');
const { verify, referenceStatus } = require('../src/verify');

// Deterministic PRNG (mulberry32) so the enumeration is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = Date.parse('2026-01-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const H = 3600 * 1000;

// Build a random DAG over n nodes: node i may only point to nodes j < i.
function randomDag(n, rand) {
  const parents = new Map();
  for (let i = 0; i < n; i += 1) {
    const ps = [];
    for (let j = 0; j < i; j += 1) {
      if (rand() < 0.35) ps.push(`n${j}`);
    }
    if (ps.length > 0) parents.set(`n${i}`, ps);
  }
  return parents;
}

test('acceptance 4: closure BFS == fixpoint for all enumerated DAGs, n <= 8', () => {
  let checked = 0;
  for (let n = 1; n <= 8; n += 1) {
    for (let seed = 0; seed < 200; seed += 1) {
      const rand = rng(seed * 1000 + n);
      const parents = randomDag(n, rand);
      for (let i = 0; i < n; i += 1) {
        const a = closureBFS(parents, `n${i}`).set;
        const b = closureFixpoint(parents, `n${i}`);
        assert.deepEqual([...a].sort(), [...b].sort());
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0);
  console.log(`  cross-checked ${checked} closures`);
});

// Turn a DAG into a random-but-valid event log: samples at roots, aliquots in
// the middle, assays at leaves; sprinkle qc_fail / revoke / attest.
function dagToEvents(n, parents, rand) {
  const events = [{ type: 'register', id: 'B', kind: 'batch', reagent: 'R1', time: iso(T0) }];
  const depth = new Map();
  const depthOf = (id) => {
    if (!depth.has(id)) {
      const ps = parents.get(id) || [];
      depth.set(id, ps.length === 0 ? 0 : 1 + Math.max(...ps.map(depthOf)));
    }
    return depth.get(id);
  };
  const assays = [];
  for (let i = 0; i < n; i += 1) {
    const id = `n${i}`;
    const ps = (parents.get(id) || []).filter((p) => state_kind(p) !== 'batch');
    const d = depthOf(id);
    const t = iso(T0 + d * H);
    if (ps.length === 0) {
      events.push({ type: 'register', id, kind: 'sample', volume: 1000, time: iso(T0) });
    } else if (rand() < 0.5) {
      events.push({ type: 'aliquot', id, parent: ps[0], volume: 10, time: t });
    } else {
      events.push({ type: 'assay', id, parent: ps[0], batch: 'B', reagent: 'R1', conclusion: `c-${id}`, time: t });
      assays.push(id);
    }
  }
  for (let i = 0; i < n; i += 1) {
    const r = rand();
    if (r < 0.08) events.push({ type: 'qc_fail', target: `n${i}`, time: iso(T0 + 10 * H) });
    else if (r < 0.16) events.push({ type: 'revoke', target: `n${i}`, reason: 'rand', time: iso(T0 + 10 * H) });
  }
  for (const a of assays) {
    if (rand() < 0.2) events.push({ type: 'attest', target: a, signature: 'sig:x', time: iso(T0 + 10 * H) });
  }
  return events;
}
function state_kind() { return undefined; }

test('acceptance 4: verify engine == brute-force reference, n <= 8', () => {
  let checked = 0;
  const now = iso(T0 + 50 * H);
  for (let n = 1; n <= 8; n += 1) {
    for (let seed = 0; seed < 100; seed += 1) {
      const rand = rng(seed * 77 + n * 13);
      const parents = randomDag(n, rand);
      const events = dagToEvents(n, parents, rand);
      const state = foldEvents(events);
      const { results } = verify(state, { now });
      for (const r of results) {
        assert.equal(r.status, referenceStatus(state, r.assay, now),
          `mismatch for assay ${r.assay} (n=${n}, seed=${seed})`);
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0);
  console.log(`  cross-checked ${checked} assay verdicts`);
});
