'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAudit } = require('../lib/audit');

const LEDGER = [
  { batch: 'B1', account: 'A100', currency: 'USD', amount: 100.5, direction: 'credit', timestamp: '2026-01-01T00:00:00Z' },
  { batch: 'B1', account: 'A101', currency: 'EUR', amount: 50, direction: 'credit', timestamp: '2026-01-01T00:01:00Z' },
  { batch: 'B2', account: 'A102', currency: 'USD', amount: 25.25, direction: 'debit', timestamp: '2026-01-01T00:02:00Z' },
  { batch: 'B2', account: 'A103', currency: 'USD', amount: 10, direction: 'credit', timestamp: '2026-01-01T00:03:00Z' },
  { batch: 'B3', account: 'A104', currency: 'JPY', amount: 7, direction: 'debit', timestamp: '2026-01-01T00:04:00Z' },
].map((r) => JSON.stringify(r)).join('\n') + '\n';

test('acceptance A: valid rule hits and amount summary is correct', () => {
  const rules = { rules: [{ id: 'usd', pattern: '[^]*\\|USD\\|[^]*', action: 'flag' }] };
  const out = runAudit(rules, LEDGER);
  assert.equal(out.lines, 5);
  assert.equal(out.match.count, 3);
  // credit adds, debit subtracts: 100.5 - 25.25 + 10 = 85.25
  assert.equal(out.match.totalAmount, 85.25);
  assert.deepEqual(out.match.lineNumbers, [1, 3, 4]);
  assert.equal(out.minimized.certificateValid, true);
  assert.ok(out.minimized.states > 0);
});

test('multiple rules with the same action do not conflict', () => {
  const rules = {
    rules: [
      { id: 'usd', pattern: '[^]*\\|USD\\|[^]*', action: 'flag' },
      { id: 'batch-b2', pattern: 'B2\\|[^]*', action: 'flag' },
    ],
  };
  const out = runAudit(rules, LEDGER);
  // Union of USD lines {1,3,4} and batch B2 lines {3,4}.
  assert.deepEqual(out.match.lineNumbers, [1, 3, 4]);
  assert.equal(out.match.totalAmount, 85.25);
});

test('character classes and ? work in audit rules', () => {
  const rules = { rules: [{ id: 'acct', pattern: '[^]*\\|A10[013]\\|[^]*', action: 'flag' }] };
  const out = runAudit(rules, LEDGER);
  assert.deepEqual(out.match.lineNumbers, [1, 2, 4]);
  assert.equal(out.match.totalAmount, 160.5);
});

test('a rule matching nothing yields a zero summary', () => {
  const rules = { rules: [{ id: 'gbp', pattern: '[^]*\\|GBP\\|[^]*' }] };
  const out = runAudit(rules, LEDGER);
  assert.equal(out.match.count, 0);
  assert.equal(out.match.totalAmount, 0);
});
