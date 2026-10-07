'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuleSet } = require('../src/rules');
const { evaluate } = require('../src/engine');

// Scale: 100k transactions, rules within 60 characters.
test('evaluates 100k transactions against a multi-rule set', { timeout: 60000 }, () => {
  const rules = [
    'night = [a3t0**h1]',
    'burst = [***c1*][***c1*][***c1*]',
    'sanct = [a2*r2**]|[a3*r2**]',
  ].join('\n');
  for (const line of rules.split('\n')) {
    const body = line.split('=')[1].trim();
    assert.ok(body.length <= 60, `rule too long: ${body}`);
  }
  const rs = loadRuleSet(rules);

  const N = 100000;
  const txs = new Array(N);
  const regions = ['domestic', 'crossborder', 'sanctioned'];
  const channels = ['pos', 'online', 'atm'];
  for (let i = 0; i < N; i++) {
    txs[i] = {
      id: `tx${i}`,
      account: `acct${i % 1000}`,
      amount: (i * 7919) % 50000,
      hour: i % 24,
      region: regions[i % 3],
      channel: channels[i % 3],
      history: i % 7 === 0 ? 'flagged' : 'clean',
    };
  }
  const start = Date.now();
  const decisions = evaluate(rs, txs);
  const elapsed = Date.now() - start;
  assert.equal(decisions.length, N);
  const rejects = decisions.filter((d) => d.decision === 'REJECT').length;
  assert.ok(rejects > 0, 'expected some rejects in synthetic log');
  console.log(`    # 100k tx evaluated in ${elapsed}ms, rejects=${rejects}`);
});
