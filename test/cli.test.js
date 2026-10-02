'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/cli');

test('cli end-to-end: JSON commands, query flags, error codes', () => {
  const db = path.join(os.tmpdir(), `ledger-cli-${process.pid}-${Date.now()}.json`);
  fs.rmSync(db, { force: true });
  const run = (args) => execute(['--db', db, ...args]);

  try {
    let res = run([JSON.stringify({ cmd: 'createAccount', account: 'A', total: 1000 })]);
    assert.equal(res.ok, true);

    res = run([JSON.stringify({ cmd: 'freeze', account: 'A', holdId: 'h1', amount: 250, dueDate: '2026-01-10' })]);
    assert.equal(res.ok, true);
    assert.equal(res.result.available, 750);

    res = run(['query', '--account', 'A', '--status', 'HELD', '--due-before', '2026-02-01']);
    assert.deepEqual(res.result.map((h) => h.id), ['h1']);

    res = run([JSON.stringify({ cmd: 'pay', holdId: 'h1', paymentId: 'p1' })]);
    assert.equal(res.result.total, 750);

    res = run(['query', '--account', 'A', '--status', 'HELD']);
    assert.deepEqual(res.result, []);
    res = run(['query', '--account', 'A', '--status', 'SETTLED']);
    assert.deepEqual(res.result.map((h) => h.id), ['h1']);

    res = run([JSON.stringify({ cmd: 'cancelPay', paymentId: 'p1' })]);
    assert.equal(res.result.id, 'rf_p1');
    assert.equal(res.result.amount, 250);

    res = run([JSON.stringify({ cmd: 'release', holdId: 'h1' })]);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'E_HOLD_STATE');

    res = run([JSON.stringify({ cmd: 'freeze', account: 'GHOST', holdId: 'hx', amount: 1, dueDate: '2026-01-01' })]);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'E_NO_ACCOUNT');

    res = run([JSON.stringify({ cmd: 'freeze', account: 'A', holdId: 'h2', amount: 999999, dueDate: '2026-01-01' })]);
    assert.equal(res.error, 'E_INSUFFICIENT');

    // State persists across invocations via the db file.
    res = run(['query', '--account', 'A']);
    assert.deepEqual(res.result.map((h) => h.id), ['h1']);
  } finally {
    fs.rmSync(db, { force: true });
  }
});
