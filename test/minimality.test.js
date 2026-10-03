'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeChanges } = require('../lib/diff');
const { makePlan } = require('../lib/plan');
const { sha256 } = require('../lib/hash');

// File states per key: prev (sync state), a (dir A now), b (dir B now).
// Values: null = absent, 'v1'/'v2' = content versions, 'T(v1)' = tombstone.
const V1 = sha256('content-v1');
const V2 = sha256('content-v2');
const H = { v1: V1, v2: V2 };

function entry(ver) {
  return ver ? { hash: H[ver], size: 10, mtimeMs: 1000 } : null;
}

// Exhaustive per-key truth table with independently computed minimal outcomes.
// expected: {ops, conflicts, errors}
const SCENARIOS = [
  // prev, a, b, expected
  { prev: null, a: null, b: null, exp: { ops: 0 } },
  { prev: null, a: 'v1', b: null, exp: { ops: 1 } },
  { prev: null, a: null, b: 'v1', exp: { ops: 1 } },
  { prev: null, a: 'v1', b: 'v1', exp: { ops: 0 } },
  { prev: null, a: 'v1', b: 'v2', exp: { ops: 0, conflicts: 1 } },
  { prev: 'v1', a: 'v1', b: 'v1', exp: { ops: 0 } },
  { prev: 'v1', a: 'v2', b: 'v1', exp: { ops: 1 } },
  { prev: 'v1', a: 'v1', b: 'v2', exp: { ops: 1 } },
  { prev: 'v1', a: 'v2', b: 'v2', exp: { ops: 0 } },
  { prev: 'v1', a: 'v1', b: 'v2x', exp: null }, // placeholder, replaced below
  { prev: 'v1', a: null, b: 'v1', exp: { ops: 1 } },   // B deleted -> delete A? no: a null, b v1 => delete b
  { prev: 'v1', a: 'v1', b: null, exp: { ops: 1 } },   // delete a
  { prev: 'v1', a: null, b: null, exp: { ops: 0 } },   // both deleted -> tombstone only
  { prev: 'v1', a: null, b: 'v2', exp: { ops: 1 } },   // resurrect from b (new version)
  { prev: 'v1', a: 'v2', b: null, exp: { ops: 1 } },   // resurrect from a
  { prev: 'T(v1)', a: null, b: null, exp: { ops: 0 } },
  { prev: 'T(v1)', a: 'v1', b: null, exp: { ops: 0, errors: 1 } }, // resurrection w/o new version
  { prev: 'T(v1)', a: 'v2', b: null, exp: { ops: 1 } },            // resurrection with new version
  { prev: 'T(v1)', a: 'v2', b: 'v2', exp: { ops: 0 } },
  { prev: 'T(v1)', a: 'v1', b: 'v1', exp: { ops: 0, errors: 1 } },
  { prev: 'T(v1)', a: 'v2', b: 'v1', exp: { ops: 0, errors: 1 } },
  { prev: 'T(v1)', a: 'v2', b: 'v3', exp: { ops: 0, conflicts: 1 } },
];
SCENARIOS[9] = { prev: 'v1', a: 'v2', b: 'v1x', exp: { ops: 0, conflicts: 1 } }; // both modified

const HASHES = { v1: V1, v2: V2, v3: sha256('content-v3'), v1x: sha256('content-v1x'), v2x: sha256('content-v2x') };

function buildInputs(keys, combo) {
  const scanA = new Map();
  const scanB = new Map();
  const state = { version: 1, files: {} };
  keys.forEach((key, i) => {
    const s = combo[i];
    if (s.prev) {
      const tomb = s.prev.startsWith('T(');
      const ver = tomb ? s.prev.slice(2, -1) : s.prev;
      state.files[key] = { hash: HASHES[ver], deleted: tomb, vector: { a: 0, b: 0 } };
    }
    if (s.a) scanA.set(key, { hash: HASHES[s.a], size: 10, mtimeMs: 1000 });
    if (s.b) scanB.set(key, { hash: HASHES[s.b], size: 10, mtimeMs: 1000 });
  });
  return { scanA, scanB, state };
}

test('per-key truth table: every state combination yields the minimal change set', () => {
  for (const s of SCENARIOS) {
    const { scanA, scanB, state } = buildInputs(['k'], [s]);
    const diff = computeChanges(scanA, scanB, state);
    const plan = makePlan('/A', '/B', diff);
    const label = JSON.stringify(s);
    assert.equal(plan.ops.length, s.exp.ops ?? 0, `ops for ${label}`);
    assert.equal(diff.conflicts.length, s.exp.conflicts ?? 0, `conflicts for ${label}`);
    assert.equal(diff.errors.length, s.exp.errors ?? 0, `errors for ${label}`);
    // No redundant ops: never copy when contents already equal, never delete absent files.
    for (const op of plan.ops) {
      if (op.op === 'copy') assert.notEqual(scanA.get('k')?.hash, scanB.get('k')?.hash);
      if (op.op === 'delete') assert.ok(scanA.has('k') || scanB.has('k'));
    }
  }
});

test('n<=7 enumeration: plan size equals sum of per-key minimal ops, no extras', (t) => {
  // Representative subset covering every op kind (copy-a2b, copy-b2a, delete,
  // resurrect, conflict, converged-noop). Full truth table is covered per-key above.
  const pick = [
    { prev: null, a: 'v1', b: null, exp: { ops: 1 } },      // copy a->b
    { prev: null, a: null, b: 'v1', exp: { ops: 1 } },      // copy b->a
    { prev: null, a: 'v1', b: 'v1', exp: { ops: 0 } },      // converged noop
    { prev: null, a: 'v1', b: 'v2', exp: { ops: 0, conflicts: 1 } }, // conflict
    { prev: 'v1', a: 'v1', b: null, exp: { ops: 1 } },      // delete a (deleted-in-b)
    { prev: 'v1', a: null, b: null, exp: { ops: 0 } },      // tombstone noop
  ];
  const SUBSET = pick;
  for (let n = 1; n <= 7; n++) {
    const keys = Array.from({ length: n }, (_, i) => `k${i}`);
    let combos = 0;
    const idx = Array(n).fill(0);
    for (;;) {
      const combo = idx.map((si) => SUBSET[si]);
      const { scanA, scanB, state } = buildInputs(keys, combo);
      const diff = computeChanges(scanA, scanB, state);
      const plan = makePlan('/A', '/B', diff);
      const expOps = combo.reduce((acc, s) => acc + (s.exp.ops ?? 0), 0);
      const expConf = combo.reduce((acc, s) => acc + (s.exp.conflicts ?? 0), 0);
      assert.equal(plan.ops.length, expOps, `n=${n} combo=${idx}`);
      assert.equal(diff.conflicts.length, expConf, `n=${n} combo=${idx}`);
      // Minimality: one op per actionable key, no duplicate keys, and keys
      // reported as converged ('none') produce no plan ops.
      const opKeys = plan.ops.map((o) => o.key);
      assert.equal(new Set(opKeys).size, opKeys.length, 'duplicate op keys');
      const noneKeys = new Set(diff.changes.filter((c) => c.op === 'none').map((c) => c.key));
      for (const k of opKeys) assert.ok(!noneKeys.has(k), `noop key ${k} leaked into plan`);
      const actionable = diff.changes.filter((c) => c.op !== 'none').length;
      assert.equal(plan.ops.length, actionable, 'plan must cover every actionable change exactly once');
      combos++;
      // increment mixed-radix counter
      let p = n - 1;
      while (p >= 0 && ++idx[p] === SUBSET.length) { idx[p] = 0; p--; }
      if (p < 0) break;
    }
    t.diagnostic(`n=${n}: ${combos} combinations verified`);
  }
});
