'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../cli');

function run(args, ledgerFile) {
  let out = '';
  const code = runCli(args, { ledgerFile, write: (s) => { out += s; } });
  return { code, json: JSON.parse(out.trim()) };
}

test('CLI lifecycle: trade, cancel, restore, get', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'ledger.json');

  let r = run(['trade', 'T1'], file);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state, 'active');

  r = run(['get', 'T1'], file);
  assert.deepEqual(r.json, { tradeId: 'T1', state: 'active', tombstone: null });

  // Restore before any cancel is rejected.
  r = run(['restore', 'T1'], file);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'restore-without-cancel' });

  r = run(['cancel', 'T1'], file);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'cancelled');
  assert.equal(typeof r.json.tombstone, 'string');

  r = run(['restore', 'T1'], file);
  assert.equal(r.code, 0);
  assert.equal(r.json.state, 'active');

  r = run(['get', 'T1'], file);
  assert.deepEqual(r.json, { tradeId: 'T1', state: 'active', tombstone: null });
});

test('CLI errors are JSON with exit code 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'ledger.json');

  let r = run(['get', 'NOPE'], file);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'unknown-trade' });

  r = run(['cancel', 'NOPE'], file);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'unknown-trade' });

  r = run(['bogus'], file);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'usage' });
});

test('CLI merge imports events and stays idempotent on replay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const fileA = path.join(dir, 'a.json');
  const fileB = path.join(dir, 'b.json');

  assert.equal(run(['trade', 'T1'], fileA).code, 0);
  assert.equal(run(['cancel', 'T1'], fileA).code, 0);
  assert.equal(run(['restore', 'T1'], fileA).code, 0);

  // B starts from a stale copy taken right after the cancel.
  const stale = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  stale.events = stale.events.filter((e) => e.type !== 'restore');
  fs.writeFileSync(fileB, JSON.stringify(stale));
  assert.equal(run(['get', 'T1'], fileB).json.state, 'cancelled');

  // B merges A (which has the restore) and converges to active.
  let r = run(['merge', fileA], fileB);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.added, 1);
  assert.equal(run(['get', 'T1'], fileB).json.state, 'active');

  // The stale replica's old events replayed back into A change nothing.
  r = run(['merge', fileB], fileA);
  assert.equal(r.code, 0);
  assert.equal(r.json.added, 0);
  assert.equal(run(['get', 'T1'], fileA).json.state, 'active');
});
