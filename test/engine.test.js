'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRuleSet } = require('../src/rules');
const { evaluate } = require('../src/engine');
const { StateStore } = require('../src/state');

const HIGH_RISK_RULE = 'high = [a3t0r2c*h1]\n';

function highRiskTx(id, account) {
  return {
    id,
    account,
    amount: 20000,
    hour: 2,
    region: 'sanctioned',
    channel: 'online',
    history: 'flagged',
  };
}

function cleanTx(id, account, amount = 50) {
  return {
    id,
    account,
    amount,
    hour: 10,
    region: 'domestic',
    channel: 'pos',
    history: 'clean',
  };
}

// Acceptance A: high-risk combination is rejected.
test('high-risk combination is rejected, clean transaction approved', () => {
  const rs = loadRuleSet(HIGH_RISK_RULE);
  const txs = [cleanTx('t1', 'acct1'), highRiskTx('t2', 'acct1')];
  const decisions = evaluate(rs, txs);
  assert.equal(decisions[0].decision, 'APPROVE');
  assert.equal(decisions[1].decision, 'REJECT');
  assert.equal(decisions[1].token, 'a3t0r2c1h1');
  assert.deepEqual(decisions[1].rules, ['high']);
});

// Failed transactions must not produce freeze side effects.
test('rejected transaction freezes nothing on apply', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-'));
  const store = new StateStore(dir);
  const rs = loadRuleSet(HIGH_RISK_RULE);
  const txs = [cleanTx('t1', 'acct1', 500), highRiskTx('t2', 'acct1')];
  const decisions = evaluate(rs, txs);
  const { state } = store.apply('batch-1', txs, decisions);
  assert.equal(state.accounts.acct1.frozen, 500);
  // undo returns to pre-apply state
  store.undo();
  assert.equal(store.loadState().accounts.acct1.frozen, 0);
});

test('sequence rule rejects the transaction completing the pattern', () => {
  const rs = loadRuleSet('burst = [***c1*][***c1*][***c1*]\n');
  const online = (id) => ({ ...cleanTx(id, 'a'), channel: 'online' });
  const txs = [online('t1'), online('t2'), online('t3'), cleanTx('t4', 'a')];
  const decisions = evaluate(rs, txs);
  assert.deepEqual(
    decisions.map((d) => d.decision),
    ['APPROVE', 'APPROVE', 'REJECT', 'APPROVE']
  );
});
