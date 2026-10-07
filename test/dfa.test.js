'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph, toNFA } = require('../src/genealogy');
const { ALPHABET, determinize, minimize, canonical, equivalent } = require('../src/dfa');

const buildMin = (records) => minimize(determinize(toNFA(buildGraph(records))));

const runString = (min, str) => {
  let s = min.start;
  for (const sym of str) s = min.states.get(s).trans[sym];
  return min.states.get(s).output;
};

// Acceptance 1: isomorphic genealogies with different names minimize to the
// same state count and the same canonical certificate.
test('isomorphic genealogies minimize identically', () => {
  const shape = (n) => [
    { batch: n('r'), defects: ['d0'] },
    { batch: n('a'), op: 'split', parents: [n('r')], defects: ['d1'] },
    { batch: n('b'), op: 'split', parents: [n('r')] },
    { batch: n('m'), op: 'merge', parents: [n('a'), n('b')] },
    { batch: n('t'), op: 'test', parents: [n('m')], status: 'pending' },
    { batch: n('s'), op: 'ship', parents: [n('t')] },
  ];
  const names1 = (x) => ({ r: 'raw', a: 'cook-a', b: 'cook-b', m: 'pack', t: 'qc', s: 'out' })[x];
  const names2 = (x) => ({ r: 'src', a: 'cut-a', b: 'cut-b', m: 'bundle', t: 'inspect', s: 'ship' })[x];
  const minA = buildMin(shape(names1));
  const minB = buildMin(shape(names2));
  assert.equal(minA.states.size, minB.states.size);
  assert.equal(canonical(minA), canonical(minB));
  const res = equivalent(minA, minB);
  assert.equal(res.equal, true);
  assert.match(res.certificate, /^[0-9a-f]{64}$/);
});

// Acceptance 2: non-equivalent rules yield a shortest witness string after
// which the reachable defect sets differ.
test('non-equivalent genealogies yield a shortest witness', () => {
  const minA = buildMin([
    { batch: 'r', defects: ['d0'] },
    { batch: 'a', op: 'split', parents: ['r'], defects: ['d1'] },
    { batch: 't', op: 'test', parents: ['a'], defects: ['d2'] },
  ]);
  const minB = buildMin([
    { batch: 'r', defects: ['d0'] },
    { batch: 'a', op: 'split', parents: ['r'], defects: ['d1'] },
    { batch: 't', op: 'test', parents: ['a'], defects: ['d3'] },
  ]);
  const res = equivalent(minA, minB);
  assert.equal(res.equal, false);
  assert.deepEqual(res.witness, ['split', 'test']);
  // The witness really distinguishes them...
  assert.notDeepEqual(runString(minA, res.witness), runString(minB, res.witness));
  // ...and no shorter string does (shortest certificate of inequivalence).
  for (let len = 0; len < res.witness.length; len++) {
    const total = 4 ** len;
    for (let mask = 0; mask < total; mask++) {
      const str = [];
      let m = mask;
      for (let i = 0; i < len; i++) {
        str.push(ALPHABET[m % 4]);
        m = Math.floor(m / 4);
      }
      assert.deepEqual(runString(minA, str), runString(minB, str));
    }
  }
});

test('split is nondeterministic: subset construction tracks the batch set', () => {
  const dfa = determinize(
    toNFA(
      buildGraph([
        { batch: 'r' },
        { batch: 'a', op: 'split', parents: ['r'], defects: ['da'] },
        { batch: 'b', op: 'split', parents: ['r'], defects: ['db'] },
      ])
    )
  );
  const start = dfa.states.get(dfa.start);
  const after = dfa.states.get(start.trans.split);
  assert.deepEqual(after.members, ['a', 'b']);
  assert.deepEqual(after.output, ['da', 'db']);
});

test('merge of a split view collapses back to one batch', () => {
  const dfa = determinize(
    toNFA(
      buildGraph([
        { batch: 'r' },
        { batch: 'a', op: 'split', parents: ['r'] },
        { batch: 'b', op: 'split', parents: ['r'] },
        { batch: 'm', op: 'merge', parents: ['a', 'b'], defects: ['dm'] },
      ])
    )
  );
  const splitView = dfa.states.get(dfa.states.get(dfa.start).trans.split);
  const merged = dfa.states.get(splitView.trans.merge);
  assert.deepEqual(merged.members, ['m']);
  assert.deepEqual(merged.output, ['dm']);
});

test('empty genealogy minimizes to the single empty view', () => {
  const min = buildMin([]);
  assert.equal(min.states.size, 1);
  assert.deepEqual(min.states.get(min.start).output, []);
});
