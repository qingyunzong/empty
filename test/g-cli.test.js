'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { replay } = require('../cli.js');

function writeFixture() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-')), 'events.jsonl');
  const events = [
    { id: 'e1', type: 'open', account: 'a', amount: 50 },
    { id: 'e2', type: 'debit', account: 'a', amount: 80 }, // NEGATIVE -> ERROR
    { id: 'e3', type: 'credit', account: 'a', amount: 10 },
  ];
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

test('G: cli replay without --repair leaves account in ERROR', () => {
  const out = replay(writeFixture());
  assert.equal(out.accounts.a.status, 'ERROR');
  assert.equal(out.accounts.a.balance, 50);
  assert.equal(out.errors[0].code, 'NEGATIVE');
  assert.equal(out.errors[1].code, 'ILLEGAL_TRANSITION'); // e3 rejected in ERROR
});

test('G: cli replay --repair auto-recovers and continues', () => {
  const out = replay(writeFixture(), { repair: true });
  assert.equal(out.accounts.a.status, 'ACTIVE');
  assert.equal(out.accounts.a.balance, 60); // 50 + 10
  assert.equal(out.accounts.a.frozen, 0);
});
