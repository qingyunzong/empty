'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCli } = require('../src/cli');

function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-cli-'));
  const statePath = path.join(dir, 'state.json');
  const seed = {
    version: 1,
    accounts: {
      A: { available: 1000, frozen: 0, frozenLocked: 0 },
      B: { available: 1000, frozen: 0, frozenLocked: 0 },
    },
    transactions: {},
    migrations: [],
    idempotency: {},
    head: '0'.repeat(64),
  };
  fs.writeFileSync(statePath, JSON.stringify(seed));
  return { dir, statePath };
}

function apply(statePath, cmd) {
  const cmdPath = path.join(path.dirname(statePath), `cmd-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cmdPath, JSON.stringify(cmd));
  let out = '';
  const code = runCli(['apply', cmdPath, '--state', statePath], {
    stdout: (s) => { out += s; },
    stderr: () => {},
  });
  fs.rmSync(cmdPath, { force: true });
  return { code, result: JSON.parse(out) };
}

function loadState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

test('cli: transfer, full reverse, reverseReversal all exit 0', () => {
  const { statePath } = makeWorkspace();
  assert.equal(apply(statePath, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 200 }).code, 0);
  assert.equal(apply(statePath, { type: 'reverse', txId: 't1' }).code, 0);
  assert.equal(apply(statePath, { type: 'reverseReversal', txId: 't1' }).code, 0);
  const state = loadState(statePath);
  assert.equal(state.transactions.t1.status, 'RESTORED');
  assert.equal(state.accounts.A.available, 800);
  assert.equal(state.accounts.B.available, 1200);
  assert.equal(state.migrations.length, 3);
});

test('cli: illegal transition exits 15, amount out of range exits 16, unknown exits 17', () => {
  const { statePath } = makeWorkspace();
  assert.equal(apply(statePath, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100 }).code, 0);

  assert.equal(apply(statePath, { type: 'reverseReversal', txId: 't1' }).code, 15);
  assert.equal(apply(statePath, { type: 'reverse', txId: 't1', amount: 0 }).code, 16);
  assert.equal(apply(statePath, { type: 'reverse', txId: 't1', amount: 101 }).code, 16);
  assert.equal(apply(statePath, { type: 'teleport' }).code, 17);

  // Terminal state rejects further operations with 15.
  assert.equal(apply(statePath, { type: 'reverse', txId: 't1' }).code, 0);
  assert.equal(apply(statePath, { type: 'reverseReversal', txId: 't1' }).code, 0);
  assert.equal(apply(statePath, { type: 'reverse', txId: 't1' }).code, 15);
  assert.equal(apply(statePath, { type: 'reverseReversal', txId: 't1' }).code, 15);
});

test('cli: duplicate idempotencyKey replays original result without double-applying', () => {
  const { statePath } = makeWorkspace();
  const cmd = { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100, idempotencyKey: 'k1' };
  assert.equal(apply(statePath, cmd).code, 0);
  const replay = apply(statePath, cmd);
  assert.equal(replay.code, 0);
  assert.equal(replay.result.replayed, true);
  const state = loadState(statePath);
  assert.equal(state.accounts.A.available, 900);
  assert.equal(state.accounts.B.available, 1100);
  assert.equal(state.migrations.length, 1);

  // Failed command results are also replayed.
  const bad = { type: 'reverse', txId: 't1', amount: 0, idempotencyKey: 'k2' };
  assert.equal(apply(statePath, bad).code, 16);
  const badReplay = apply(statePath, bad);
  assert.equal(badReplay.code, 16);
  assert.equal(badReplay.result.replayed, true);
});

test('cli: verify reports ok for consistent state and detects tampering', () => {
  const { statePath } = makeWorkspace();
  apply(statePath, { type: 'transfer', id: 't1', from: 'A', to: 'B', amount: 100 });

  let out = '';
  const okCode = runCli(['verify', '--state', statePath], { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.equal(okCode, 0);
  assert.equal(JSON.parse(out).ok, true);

  const state = loadState(statePath);
  state.migrations[0].amount = 999;
  fs.writeFileSync(statePath, JSON.stringify(state));
  out = '';
  const badCode = runCli(['verify', '--state', statePath], { stdout: (s) => { out += s; }, stderr: () => {} });
  assert.equal(badCode, 1);
  assert.equal(JSON.parse(out).ok, false);
});
