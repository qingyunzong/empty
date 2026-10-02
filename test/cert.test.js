'use strict';
// Acceptance 4: terminal certificates are recomputable offline from the event
// log alone — the test recomputes hashes with its own independent projection
// (reference state machine) and its own canonicalization, then compares with
// the CLI output. Also checks determinism across runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { refProject } = require('./refmodel');
const { run } = require('../cli');

const LOG = [
  { type: 'sale', id: 's1', account: 'alice', amount: 200 },
  { type: 'sale', id: 's2', account: 'bob', amount: 120 },
  { type: 'sale', id: 's3', account: 'alice', amount: 80 },
  { type: 'refund', id: 'r1', saleId: 's1', account: 'alice', amount: 50 },
  { type: 'unfreeze', account: 'alice', amount: 30 },
  { type: 'freeze', account: 'alice', amount: 20 },
  { type: 'refund', id: 'r2', saleId: 's2', account: 'bob', amount: 120 },
  { type: 'refundVoid', refundId: 'r2' },
  { type: 'refund', id: 'r3', saleId: 's2', account: 'bob', amount: 40 },
];

function offlineCanonical(value) {
  if (Array.isArray(value)) return '[' + value.map(offlineCanonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + offlineCanonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function offlineCert(events) {
  const { accounts } = refProject(events);
  const perAccount = {};
  for (const name of Object.keys(accounts).sort()) {
    const a = accounts[name];
    perAccount[name] = crypto
      .createHash('sha256')
      .update(offlineCanonical({ account: name, balance: a.balance, frozen: a.frozen }))
      .digest('hex');
  }
  const overall = crypto
    .createHash('sha256')
    .update(Object.keys(perAccount).map((k) => k + ':' + perAccount[k]).join('\n'))
    .digest('hex');
  return { accounts: perAccount, overall };
}

test('cert is recomputable offline from the event log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, LOG.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const out1 = JSON.parse(run(['cert', file]).stdout);
  const out2 = JSON.parse(run(['cert', file]).stdout);
  assert.deepStrictEqual(out1, out2, 'cert must be deterministic');
  const expected = offlineCert(LOG);
  assert.deepStrictEqual(out1, expected);
  assert.equal(Object.keys(out1.accounts).length, 2);
  assert.match(out1.overall, /^[0-9a-f]{64}$/);
});

test('guard CLI rejects invalid event with exit 1 and certificate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'sale', id: 's1', account: 'a', amount: 10 }) + '\n');
  const res = run(['guard', file, JSON.stringify({ type: 'refund', id: 'r1', saleId: 'ghost', account: 'a', amount: 5 })]);
  assert.equal(res.code, 1);
  const verdict = JSON.parse(res.stdout);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, 30);
  assert.equal(verdict.certificate.code, 30);
  assert.match(verdict.certificate.stateHash, /^[0-9a-f]{64}$/);
});
