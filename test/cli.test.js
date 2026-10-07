import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../cli.js';

function dir() {
  return mkdtempSync(join(tmpdir(), 'ledger-cli-'));
}

test('CLI end-to-end acceptance flow', () => {
  const file = join(dir(), 'ledger.json');

  let r = run(['add-account', 'alice', '--file', file]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, account: 'alice', incarnation: 'alice#1', epoch: 0 });

  r = run(['add-account', 'bob', '--file', file]);
  assert.equal(r.code, 0);

  r = run(['pay', 'alice', '100', '--file', file]);
  assert.equal(r.code, 0);
  assert.equal(r.json.balance, 100);

  // Acceptance 2: removal with balance is rejected.
  r = run(['remove-account', 'alice', '--file', file]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'balance-not-zero' });

  // Acceptance 1: zeroing transfer makes removal succeed.
  r = run(['transfer', 'alice', 'bob', '100', '--file', file]);
  assert.equal(r.code, 0);
  assert.equal(r.json.fromBalance, 0);
  assert.equal(r.json.toBalance, 100);

  r = run(['remove-account', 'alice', '--file', file]);
  assert.equal(r.code, 0);
  assert.equal(r.json.epoch, 1);

  // Historical pay remains auditable.
  r = run(['account', 'alice', '--file', file]);
  assert.equal(r.code, 0);
  assert.equal(r.json.status, 'removed');
  assert.equal(r.json.balance, 0);
  const historicalPay = r.json.history.find((e) => e.type === 'pay');
  assert.equal(historicalPay.amount, 100);

  // Acceptance 3: pay after removal is rejected.
  r = run(['pay', 'alice', '5', '--file', file]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'account-removed' });

  // Re-adding the same name creates a fresh incarnation with zero balance.
  r = run(['add-account', 'alice', '--file', file]);
  assert.equal(r.code, 0);
  assert.equal(r.json.incarnation, 'alice#2');

  r = run(['account', 'alice', '--file', file]);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.balance, 0);
  assert.equal(r.json.epoch, 1);
});

test('CLI merge reports conflict for concurrent remove and pay', () => {
  const d = dir();
  const base = join(d, 'base.json');
  const left = join(d, 'left.json');
  const right = join(d, 'right.json');

  assert.equal(run(['add-account', 'alice', '--file', base]).code, 0);
  copyFileSync(base, left);
  copyFileSync(base, right);

  assert.equal(run(['remove-account', 'alice', '--file', left, '--replica', 'left']).code, 0);
  assert.equal(run(['pay', 'alice', '10', '--file', right, '--replica', 'right']).code, 0);

  const r = run(['merge', right, '--file', left]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'conflict' });
});

test('CLI merge combines non-conflicting histories', () => {
  const d = dir();
  const base = join(d, 'base.json');
  const left = join(d, 'left.json');
  const right = join(d, 'right.json');

  assert.equal(run(['add-account', 'alice', '--file', base]).code, 0);
  copyFileSync(base, left);
  copyFileSync(base, right);

  assert.equal(run(['pay', 'alice', '10', '--file', left, '--replica', 'left']).code, 0);
  assert.equal(run(['pay', 'alice', '5', '--file', right, '--replica', 'right']).code, 0);

  const r = run(['merge', right, '--file', left]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.json, { ok: true, merged: 1 });

  const state = run(['account', 'alice', '--file', left]);
  assert.equal(state.json.balance, 15);
});

test('CLI errors: unknown account, invalid amount, unknown command', () => {
  const file = join(dir(), 'ledger.json');

  let r = run(['pay', 'ghost', '1', '--file', file]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'no-such-account' });

  run(['add-account', 'alice', '--file', file]);
  r = run(['pay', 'alice', '-3', '--file', file]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'invalid-amount' });

  r = run(['bogus', '--file', file]);
  assert.equal(r.code, 1);
  assert.deepEqual(r.json, { error: 'unknown-command' });
});
