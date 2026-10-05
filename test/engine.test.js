'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRulesText } = require('../src/ruleset');
const { compileSearchDFA, evaluateTokens } = require('../src/engine');
const { tokenizeTx } = require('../src/tokens');

// Acceptance A: high-risk combinations are rejected.

const RULES = `
# very-high amount at night from foreign region
XNF..
# two consecutive high-amount foreign night transactions
(HNF..)(HNF..)
# flagged history via ATM
...A1
`;

function runLog(txs) {
  const dfa = compileSearchDFA(loadRulesText(RULES));
  const tokens = txs.map(tokenizeTx);
  return evaluateTokens(dfa, tokens);
}

test('A: very-high foreign night transaction is rejected', () => {
  const hits = runLog([
    { amount: 50, hour: 10, region: 'domestic', channel: 'pos', history: false },
    { amount: 50000, hour: 2, region: 'foreign', channel: 'ecom', history: false },
  ]);
  assert.deepEqual(hits, [false, true]);
});

test('A: consecutive high foreign night transactions are rejected', () => {
  const hits = runLog([
    { amount: 5000, hour: 3, region: 'foreign', channel: 'pos', history: false },
    { amount: 6000, hour: 4, region: 'foreign', channel: 'atm', history: false },
  ]);
  assert.deepEqual(hits, [false, true]); // second one completes the pair
});

test('A: single high foreign night transaction alone is accepted', () => {
  const hits = runLog([
    { amount: 5000, hour: 3, region: 'foreign', channel: 'pos', history: false },
  ]);
  assert.deepEqual(hits, [false]);
});

test('A: flagged history via ATM is rejected', () => {
  const hits = runLog([
    { amount: 10, hour: 12, region: 'domestic', channel: 'atm', history: true },
    { amount: 10, hour: 12, region: 'domestic', channel: 'pos', history: true },
  ]);
  assert.deepEqual(hits, [true, false]);
});

test('A: pattern spanning a benign gap does not false-positive', () => {
  const hits = runLog([
    { amount: 5000, hour: 3, region: 'foreign', channel: 'pos', history: false },
    { amount: 20, hour: 14, region: 'domestic', channel: 'pos', history: false },
    { amount: 5000, hour: 3, region: 'foreign', channel: 'pos', history: false },
  ]);
  assert.deepEqual(hits, [false, false, false]);
});
