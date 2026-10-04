'use strict';
const { ProtocolError, PHASES } = require('./frames');

function validateScenario(s) {
  const fail = (m) => {
    throw new ProtocolError(`invalid scenario: ${m}`);
  };
  if (!s || typeof s !== 'object' || Array.isArray(s)) fail('must be a JSON object');
  if (!Array.isArray(s.accounts) || s.accounts.length === 0) fail('accounts must be a non-empty array');
  const acctIds = new Set();
  for (const a of s.accounts) {
    if (!a || typeof a.id !== 'string' || !a.id) fail('account needs a string id');
    if (acctIds.has(a.id)) fail(`duplicate account ${a.id}`);
    acctIds.add(a.id);
    if (!Number.isFinite(a.balance) || a.balance < 0) fail(`account ${a.id}: balance must be a number >= 0`);
    if (a.creditLimit != null && (!Number.isFinite(a.creditLimit) || a.creditLimit < 0)) fail(`account ${a.id}: bad creditLimit`);
  }
  for (const key of ['retransmitInterval', 'prepareTimeout', 'maxTime', 'latency']) {
    if (s[key] != null && (!Number.isFinite(s[key]) || s[key] <= 0)) fail(`${key} must be a positive number`);
  }
  const txIds = new Set();
  for (const tx of s.txs || []) {
    if (!tx || typeof tx.id !== 'string' || !tx.id) fail('tx needs a string id');
    if (txIds.has(tx.id)) fail(`duplicate tx ${tx.id}`);
    txIds.add(tx.id);
    if (!acctIds.has(tx.from) || !acctIds.has(tx.to)) fail(`tx ${tx.id}: from/to must be known accounts`);
    if (tx.from === tx.to) fail(`tx ${tx.id}: from and to must differ`);
    if (!Number.isFinite(tx.amount) || tx.amount <= 0) fail(`tx ${tx.id}: amount must be > 0`);
    if (tx.at != null && (!Number.isFinite(tx.at) || tx.at < 0)) fail(`tx ${tx.id}: bad at`);
  }
  for (const f of s.faults || []) {
    if (!f || !['drop', 'delay', 'duplicate', 'fragment'].includes(f.type)) fail(`bad fault type ${f && f.type}`);
    if (f.match != null && (typeof f.match !== 'object' || Array.isArray(f.match))) fail('fault match must be an object');
    if (f.occurrence != null && f.occurrence !== 'all' && (!Number.isInteger(f.occurrence) || f.occurrence < 0)) fail('fault occurrence must be a non-negative int or "all"');
    if (f.type === 'delay' && (!Number.isFinite(f.delay) || f.delay < 0)) fail('delay fault needs delay >= 0');
    if (f.type === 'duplicate' && f.times != null && (!Number.isInteger(f.times) || f.times < 1)) fail('duplicate fault needs integer times >= 1');
    if (f.type === 'fragment' && (!Number.isInteger(f.chunks) || f.chunks < 2 || f.chunks > 16)) fail('fragment fault needs chunks in 2..16');
  }
  const nodeOk = (n) => n === 'c' || (typeof n === 'string' && n.startsWith('p:') && acctIds.has(n.slice(2)));
  for (const c of s.crashes || []) {
    if (!c || !nodeOk(c.node)) fail(`bad crash node ${c && c.node}`);
    if (!['afterPrepareLog', 'afterCommitLog', 'afterApply'].includes(c.when)) fail(`bad crash point ${c && c.when}`);
    if (c.tx != null && c.tx !== '*' && typeof c.tx !== 'string') fail('crash tx must be a string or "*"');
    if (c.restartAfter != null && (!Number.isFinite(c.restartAfter) || c.restartAfter < 0)) fail('bad restartAfter');
  }
  for (const a of s.actions || []) {
    if (!a || a.op !== 'send') fail(`bad action op ${a && a.op}`);
    if (!nodeOk(a.to)) fail(`bad action target ${a.to}`);
    if (a.from != null && !nodeOk(a.from)) fail(`bad action source ${a.from}`);
    const m = a.msg || {};
    if (typeof m.tx !== 'string' || !PHASES.has(m.phase) || typeof m.acct !== 'string' || !Number.isFinite(m.amount)) {
      fail('action msg needs tx/phase/acct/amount');
    }
    if (a.at != null && (!Number.isFinite(a.at) || a.at < 0)) fail('bad action at');
  }
  for (const q of s.queries || []) {
    if (!q || q.op !== 'txStatus' || typeof q.tx !== 'string') fail('queries support only {op:"txStatus", tx}');
  }
}

module.exports = { validateScenario };
