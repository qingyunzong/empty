'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FlowError,
  parseFlow,
  compileFlow,
} = require('../lib');
const { flowLinear, flowLoop, flowMerge } = require('./helpers');

test('epsilon transition rejected with NFA_EPSILON_ONLY', () => {
  const bad = {
    states: ['a', 'b'],
    start: 'a',
    accept: ['b'],
    transitions: [['a', 'ε', 'b']],
  };
  assert.throws(() => parseFlow(bad), (e) => e instanceof FlowError && e.code === 'NFA_EPSILON_ONLY');
});

test('flow with no symbol transitions rejected with NFA_EPSILON_ONLY', () => {
  assert.throws(
    () => parseFlow({ states: ['a'], start: 'a', accept: [], transitions: [] }),
    (e) => e.code === 'NFA_EPSILON_ONLY',
  );
});

test('subset construction determinizes the NFA', () => {
  const c = compileFlow(flowLoop);
  assert.equal(c.stats.subsetStates, 7);
  for (const m of c.dfa.trans) {
    for (const [role, t] of m) {
      assert.equal(typeof t, 'number', `transition on ${role} is deterministic`);
    }
  }
});

test('minimization merges equivalent states', () => {
  const c = compileFlow(flowMerge);
  assert.equal(c.stats.subsetStates, 4);
  assert.equal(c.stats.minimizedStates, 3);
});

test('dfa hash is deterministic and canonical under state renaming', () => {
  const a = compileFlow(flowLinear);
  const renamed = {
    ...flowLinear,
    states: [...flowLinear.states].reverse(),
    transitions: [...flowLinear.transitions].reverse(),
  };
  const b = compileFlow(renamed);
  assert.equal(a.hash, b.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test('different flows produce different hashes', () => {
  assert.notEqual(compileFlow(flowLinear).hash, compileFlow(flowLoop).hash);
});
