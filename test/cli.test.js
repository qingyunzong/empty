'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// The sandbox swallows piped stdout of nested node processes, so the child
// writes its JSON output and exit code to files which we read back.
function cli(dir, args) {
  const command = ['node', CLI, ...args].map(shellQuote).join(' ');
  spawnSync('/bin/sh', ['-c', `${command} > .last-out 2> .last-err; echo $? > .last-code`], {
    cwd: dir,
    encoding: 'utf8',
  });
  const status = Number(fs.readFileSync(path.join(dir, '.last-code'), 'utf8').trim());
  const stdout = fs.readFileSync(path.join(dir, '.last-out'), 'utf8').trim();
  return {
    status,
    json: stdout ? JSON.parse(stdout) : null,
  };
}

test('CLI acceptance flow: zero, remove, audit, reject, re-open', () => {
  const dir = makeDir();

  let r = cli(dir, ['add-account', 'alice']);
  assert.equal(r.status, 0);
  const firstIncarnation = r.json.event.incarnation;
  assert.equal(r.json.event.epoch, 1);
  cli(dir, ['add-account', 'bob']);

  r = cli(dir, ['pay', 'alice', '100']);
  assert.equal(r.status, 0);
  const payId = r.json.event.id;

  // (2) remove with balance -> balance-not-zero, exit 1, JSON error
  r = cli(dir, ['remove-account', 'alice']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'balance-not-zero' });

  // (1) zeroing transfer then remove succeeds
  r = cli(dir, ['transfer', 'alice', 'bob', '100']);
  assert.equal(r.status, 0);
  r = cli(dir, ['remove-account', 'alice']);
  assert.equal(r.status, 0);
  assert.equal(r.json.event.epoch, 1);

  // (1) historical pay still auditable
  r = cli(dir, ['account', 'alice']);
  assert.equal(r.status, 0);
  assert.equal(r.json.status, 'removed');
  assert.equal(r.json.balance, 0);
  assert.equal(r.json.tombstone.epoch, 1);
  assert.ok(r.json.history.some((e) => e.id === payId && e.type === 'pay'));

  // (3) pay after remove -> account-removed
  r = cli(dir, ['pay', 'alice', '5']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'account-removed' });

  // (3) re-open same name: new incarnation, balance from zero
  r = cli(dir, ['add-account', 'alice']);
  assert.equal(r.status, 0);
  assert.notEqual(r.json.event.incarnation, firstIncarnation);
  assert.equal(r.json.event.epoch, 2);
  r = cli(dir, ['account', 'alice']);
  assert.equal(r.json.status, 'active');
  assert.equal(r.json.balance, 0);
  assert.equal(r.json.epoch, 2);
});

test('CLI merge unites logs and surfaces concurrent remove/pay conflict', () => {
  const dirA = makeDir();
  const dirB = makeDir();

  // Shared base on both sides.
  cli(dirA, ['add-account', 'alice']);
  cli(dirA, ['add-account', 'bob']);
  cli(dirA, ['pay', 'alice', '30']);
  fs.copyFileSync(path.join(dirA, 'ledger.json'), path.join(dirB, 'ledger.json'));

  // Fork A: concurrent pay. Fork B: zero out and remove.
  const pay = cli(dirA, ['pay', 'alice', '5']).json.event;
  cli(dirB, ['transfer', 'alice', 'bob', '30']);
  const remove = cli(dirB, ['remove-account', 'alice']).json.event;

  const r = cli(dirA, ['merge', path.join(dirB, 'ledger.json')]);
  assert.equal(r.status, 0);
  assert.equal(r.json.merged, 2);
  assert.equal(r.json.conflicts.length, 1);
  assert.equal(r.json.conflicts[0].type, 'remove-pay');
  assert.equal(r.json.conflicts[0].remove, remove.id);
  assert.equal(r.json.conflicts[0].event, pay.id);

  const account = cli(dirA, ['account', 'alice']).json;
  assert.equal(account.status, 'removed');
  assert.equal(account.conflicts.length, 1);
});

test('CLI validation errors are JSON with exit code 1', () => {
  const dir = makeDir();
  let r = cli(dir, ['pay', 'ghost', '10']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'unknown-account' });

  cli(dir, ['add-account', 'alice']);
  r = cli(dir, ['add-account', 'alice']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'account-exists' });

  r = cli(dir, ['pay', 'alice', '-3']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'invalid-amount' });

  r = cli(dir, ['transfer', 'alice', 'alice', '3']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'same-account' });

  r = cli(dir, ['remove-account', 'ghost']);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json, { error: 'unknown-account' });
});
