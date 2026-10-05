'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRulesText } = require('../src/ruleset');
const { compileSearchDFA, evaluateTokens } = require('../src/engine');
const { tokenizeTx } = require('../src/tokens');

// Scale: 100k transactions, rules within the 60-char limit.

const RULES = `
XNF..
(HNF..)(HNF..)
...A1
`;

function makeTxs(n) {
  const regions = ['domestic', 'foreign'];
  const channels = ['pos', 'ecom', 'atm'];
  const txs = new Array(n);
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < n; i++) {
    txs[i] = {
      id: `tx${i}`,
      account: `acct${i % 1000}`,
      amount: Math.floor(rand() * 20000),
      hour: Math.floor(rand() * 24),
      region: regions[Math.floor(rand() * 2)],
      channel: channels[Math.floor(rand() * 3)],
      history: rand() < 0.05,
    };
  }
  return txs;
}

test('scale: 100k transactions evaluated correctly and quickly', () => {
  const dfa = compileSearchDFA(loadRulesText(RULES));
  const txs = makeTxs(100000);
  const tokens = txs.map(tokenizeTx);
  const t0 = process.hrtime.bigint();
  const hits = evaluateTokens(dfa, tokens);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(hits.length, 100000);
  // cross-check every hit against the rule semantics, token by token
  let prevHighForeignNight = false;
  for (let i = 0; i < txs.length; i++) {
    const t = tokens[i];
    const expected =
      (t[0] === 'X' && t[1] === 'N' && t[2] === 'F') ||
      (prevHighForeignNight && t[0] === 'H' && t[1] === 'N' && t[2] === 'F') ||
      (t[3] === 'A' && t[4] === '1');
    assert.equal(hits[i], expected, `mismatch at tx ${i} (${t})`);
    prevHighForeignNight = t[0] === 'H' && t[1] === 'N' && t[2] === 'F';
  }
  assert.ok(elapsedMs < 5000, `evaluation too slow: ${elapsedMs.toFixed(0)}ms`);
  console.log(`    100k transactions evaluated in ${elapsedMs.toFixed(1)}ms (${hits.filter(Boolean).length} hits)`);
});
