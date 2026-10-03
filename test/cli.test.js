'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { run } = require('../cli');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trade-cli-'));
}

function invoke(args) {
  let stdout = '';
  const code = run(args, (s) => {
    stdout += s;
  });
  return { code, stdout: stdout.trim() };
}

test('CLI outputs a JSON certificate with a state hash', () => {
  const dir = tmpdir();
  const event = JSON.stringify({
    id: 'e1',
    type: 'instruction',
    tradeId: 't1',
    amount: 100,
    riskResult: 'approve',
    accountResult: 'sufficient',
  });
  const res = invoke([event, dir]);
  assert.equal(res.code, 0);
  const cert = JSON.parse(res.stdout);
  assert.equal(cert.ok, true);
  assert.equal(cert.tradeId, 't1');
  assert.equal(cert.status, 'confirmed');
  assert.match(cert.stateHash, /^[0-9a-f]{64}$/);
});

test('CLI crashBeforeConfirm then restart confirms exactly once', () => {
  const dir = tmpdir();
  const crash = invoke([
    JSON.stringify({
      id: 'e1',
      type: 'instruction',
      tradeId: 't1',
      amount: 100,
      riskResult: 'approve',
      accountResult: 'sufficient',
      crashBeforeConfirm: true,
    }),
    dir,
  ]);
  assert.equal(crash.code, 0);
  assert.equal(JSON.parse(crash.stdout).status, 'open');

  const recovered = invoke([JSON.stringify({ id: 'e2', type: 'finalize', tradeId: 't1' }), dir]);
  assert.equal(recovered.code, 0);
  assert.equal(JSON.parse(recovered.stdout).status, 'confirmed');

  const again = invoke([JSON.stringify({ id: 'e3', type: 'finalize', tradeId: 't1' }), dir]);
  assert.equal(JSON.parse(again.stdout).status, 'confirmed');
  assert.equal(JSON.parse(again.stdout).events, JSON.parse(recovered.stdout).events);
});

test('CLI errors: exit code 1 with {"error","message"} body', () => {
  const dir = tmpdir();

  const badJson = invoke(['not-json', dir]);
  assert.equal(badJson.code, 1);
  assert.equal(JSON.parse(badJson.stdout).error, 'INVALID_JSON');

  const noArgs = invoke([]);
  assert.equal(noArgs.code, 1);
  assert.equal(JSON.parse(noArgs.stdout).error, 'USAGE');

  const invalid = invoke([JSON.stringify({ id: 'e1', type: 'nope', tradeId: 't' }), dir]);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).error, 'INVALID_EVENT');

  invoke([JSON.stringify({ id: 'i1', type: 'instruction', tradeId: 't9', amount: 10 }), dir]);
  const notReady = invoke([JSON.stringify({ id: 'f1', type: 'finalize', tradeId: 't9' }), dir]);
  assert.equal(notReady.code, 1);
  const body = JSON.parse(notReady.stdout);
  assert.equal(body.error, 'TRADE_NOT_READY');
  assert.equal(typeof body.message, 'string');
});
