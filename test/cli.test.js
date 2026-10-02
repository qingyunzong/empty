import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'riskdb-cli-'));
}

function cli(dir, args) {
  return run(['--data', dir, ...args], { env: {} });
}

function okJson(res) {
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function errJson(res) {
  assert.notEqual(res.code, 0, 'expected non-zero exit');
  const parsed = JSON.parse(res.stderr);
  assert.ok(parsed.error?.code, 'error JSON must carry a code');
  return parsed;
}

test('CLI: full lifecycle with crash, resume, snapshot query and JSON errors', () => {
  const dir = tmpdir();

  let res = okJson(cli(dir, ['status']));
  assert.equal(res.index.state, 'none');

  okJson(cli(dir, ['tx', JSON.stringify({ ops: [
    { op: 'insert', account: 'a1', risk: 'r1', balance: 100 },
    { op: 'insert', account: 'a2', risk: 'r2', balance: 50 },
  ] })]));
  okJson(cli(dir, ['tx', JSON.stringify({ ops: [
    { op: 'insert', account: 'a3', risk: 'r3', balance: 10 },
    { op: 'insert', account: 'a4', risk: 'r4', balance: 20 },
  ] })]));
  okJson(cli(dir, ['tx', JSON.stringify({ ops: [{ op: 'pay', id: 'p1', from: 'a1', to: 'a2', amount: 30 }] })]));
  okJson(cli(dir, ['tx', JSON.stringify({ ops: [{ op: 'reverse', payment: 'p1' }] })]));

  // crash halfway through the scan, before the watermark
  const crash = cli(dir, ['crash', '--backfill']);
  const crashJson = errJson(crash);
  assert.equal(crash.code, 2);
  assert.equal(crashJson.error.code, 'E_SIMULATED_CRASH');

  let st = okJson(cli(dir, ['status']));
  assert.equal(st.index.state, 'building');
  assert.equal(st.index.cursor, 2);
  assert.equal(st.index.total, 4);

  // restart resumes and finishes
  const built = okJson(cli(dir, ['build-index']));
  assert.equal(built.completed, true);
  assert.equal(built.resumed, true);
  st = okJson(cli(dir, ['status']));
  assert.equal(st.index.state, 'online');
  assert.equal(st.index.entries, 4);

  // new queries go through the index
  const q = okJson(cli(dir, ['query', '--risk', 'r2']));
  assert.equal(q.source, 'index');
  assert.deepEqual(q.accounts, [{ account: 'a2', balance: 50, risk: 'r2' }]);

  // old snapshot at v3 (after pay, before reversal) uses the scan path
  const oldQ = okJson(cli(dir, ['query', '--risk', 'r1', '--at', '3']));
  assert.equal(oldQ.accounts[0].balance, 70);
  assert.equal(oldQ.source, 'scan');

  // duplicate risk flag -> JSON error, non-zero exit
  const dup = cli(dir, ['tx', JSON.stringify({ ops: [{ op: 'insert', account: 'a9', risk: 'r2' }] })]);
  assert.equal(errJson(dup).error.code, 'E_DUP_RISK');

  // malformed JSON payload -> JSON error, non-zero exit
  const bad = cli(dir, ['tx', '{not json']);
  assert.equal(errJson(bad).error.code, 'E_BAD_JSON');

  // unknown command -> usage error
  const usage = cli(dir, ['frobnicate']);
  assert.equal(errJson(usage).error.code, 'E_USAGE');

  // query beyond the last version -> JSON error
  const future = cli(dir, ['query', '--risk', 'r1', '--at', '999']);
  assert.equal(errJson(future).error.code, 'E_BAD_VERSION');
});
