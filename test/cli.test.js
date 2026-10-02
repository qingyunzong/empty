'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runScript } = require('../src/cliapp');

const root = path.join(__dirname, '..');
const runFile = (name) => runScript(fs.readFileSync(path.join(root, 'examples', name), 'utf8'));

test('cli: happy path exits 0 with final states, frozen balance and audit certificate', () => {
  const { exitCode, output } = runFile('ok.jsonl');
  const json = JSON.parse(output);
  assert.equal(exitCode, 0);
  assert.equal(json.ok, true);
  assert.equal(json.lines.every((l) => l.state === 'SETTLED'), true);
  assert.equal(json.frozen, '0.00');
  assert.equal(json.audit.valid, true);
  assert.equal(typeof json.audit.head, 'string');
});

test('cli: timeout script aborts and unfreezes', () => {
  const { exitCode, output } = runFile('timeout.jsonl');
  const json = JSON.parse(output);
  assert.equal(exitCode, 0);
  assert.equal(json.batches[0].state, 'ABORTED');
  assert.equal(json.frozen, '0.00');
});

test('cli: business rejection exits 3 with code BUSINESS_REJECTED', () => {
  const { exitCode, output } = runFile('business_reject.jsonl');
  const json = JSON.parse(output);
  assert.equal(exitCode, 3);
  assert.equal(json.ok, false);
  assert.equal(json.code, 'BUSINESS_REJECTED');
});

test('cli: protocol error exits 2 with code PROTOCOL_ERROR', () => {
  const { exitCode, output } = runFile('protocol_error.jsonl');
  const json = JSON.parse(output);
  assert.equal(exitCode, 2);
  assert.equal(json.ok, false);
  assert.equal(json.code, 'PROTOCOL_ERROR');
});

test('cli: bad input exits 2 with code BAD_INPUT', () => {
  assert.equal(runScript('{not json').exitCode, 2);
  assert.equal(JSON.parse(runScript('{not json').output).code, 'BAD_INPUT');
  assert.equal(JSON.parse(runScript('{"op":"bogus"}').output).code, 'BAD_INPUT');
});

test('cli: process-level smoke test (skipped when the sandbox forbids spawn)', (t) => {
  const r = spawnSync(process.execPath, [path.join(root, 'cli.js'), path.join(root, 'examples/ok.jsonl')], { encoding: 'utf8' });
  if (r.error && r.error.code === 'EPERM') {
    t.skip('child processes are not permitted in this environment');
    return;
  }
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).ok, true);
});
