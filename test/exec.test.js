'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../lib');
const h = require('./helpers');

const DOSES = [
  { pump_id: 'PAC-1', slot: 0, dose: 100 },
  { pump_id: 'PAC-1', slot: 1, dose: 120 },
  { pump_id: 'PAM-1', slot: 2, dose: 10 },
];

test('exec runs all steps and writes the dose ledger', async () => {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  const r = await h.exec(dir);
  assert.equal(r.status, 0, r.stderr);
  const t = h.totals(dir);
  assert.equal(t.total, 230);
  assert.deepEqual(t.perSlot, { 'PAC-1#0': 100, 'PAC-1#1': 120, 'PAM-1#2': 10 });
});

test('unknown pump exits with code 2', async () => {
  const dir = h.tmpdir();
  h.setup(dir, [{ pump_id: 'NOPE', slot: 0, dose: 5 }]);
  const r = await h.exec(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown pump: NOPE/);
});

test('negative dose exits with code 2', async () => {
  const dir = h.tmpdir();
  h.setup(dir, [{ pump_id: 'PAC-1', slot: 0, dose: -1 }]);
  const r = await h.exec(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /negative dose/);
});

test('slot overlap (duplicate pump+slot) exits with code 2', async () => {
  const dir = h.tmpdir();
  h.setup(dir, [
    { pump_id: 'PAC-1', slot: 0, dose: 5 },
    { pump_id: 'PAC-1', slot: 0, dose: 7 },
  ]);
  const r = await h.exec(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /slot overlap/);
});

test('slot overlap (overlapping time windows) exits with code 2', async () => {
  const dir = h.tmpdir();
  h.setup(dir, [
    { pump_id: 'PAC-1', slot: 0, dose: 5, start: 0, end: 60 },
    { pump_id: 'PAC-1', slot: 1, dose: 7, start: 30, end: 90 },
  ]);
  const r = await h.exec(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /slot overlap/);
});

test('acceptance 2: re-submitting the same slot does not accumulate', async () => {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  assert.equal((await h.exec(dir)).status, 0);

  // Ledger-level idempotency: the same idempotency key (pump_id+slot) twice.
  const file = h.ledgerFile(dir);
  const before = h.readLedger(dir).length;
  const appended = lib.appendLedger(file, {
    key: 'PAC-1#0',
    kind: 'dose',
    pump_id: 'PAC-1',
    slot: 0,
    dose: 100,
    seq: 0,
  });
  assert.equal(appended, false);
  assert.equal(h.readLedger(dir).length, before);
  assert.equal(h.totals(dir).total, 230);

  // Recovery is idempotent too: running it again changes nothing.
  assert.equal((await h.recover(dir)).status, 0);
  assert.equal(h.totals(dir).total, 230);
  const again = JSON.parse(fs.readFileSync(path.join(dir, 'j', 'recovered.json'), 'utf8'));
  assert.deepEqual(again.replayed, []);
  assert.deepEqual(again.checkpoint_only, []);
  assert.deepEqual(again.executed, []);
});

test('exec refuses a non-empty journal', async () => {
  const dir = h.tmpdir();
  h.setup(dir, DOSES);
  assert.equal((await h.exec(dir)).status, 0);
  const r = await h.exec(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /journal is not empty/);
});
