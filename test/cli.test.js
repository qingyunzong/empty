import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-cli-'));
}

// In-process CLI invocation with captured streams (no child processes).
function cli(...args) {
  let out = '';
  let errOut = '';
  const code = runCli(args, { stdout: (s) => (out += s), stderr: (s) => (errOut += s) });
  return { code, out, err: errOut, json: () => JSON.parse(out) };
}

function shop(dir) {
  assert.equal(cli('init', dir).code, 0);
  assert.equal(cli('machine', 'add', dir, 'M1', '--calendar', '0-480,1440-1920').code, 0);
  assert.equal(cli('machine', 'add', dir, 'M2', '--calendar', '0-960').code, 0);
  assert.equal(cli('order', 'add', dir, 'W1', '--product', 'P1', '--priority', '3', '--ops', 'M1:60,M2:30').code, 0);
  assert.equal(cli('order', 'add', dir, 'W2', '--product', 'P2', '--priority', '1', '--ops', 'M1:45,M2:60').code, 0);
  assert.equal(cli('changeover', 'set', dir, 'M1', 'P1', 'P2', '15').code, 0);
}

test('CLI end-to-end: init, populate, schedule, undo, redo, status, verify', () => {
  const dir = tmpdir();
  shop(dir);

  const sol = cli('schedule', dir).json();
  assert.equal(typeof sol.objective, 'number');
  assert.ok(sol.assignments['W1:0'].end <= sol.assignments['W1:1'].start);

  assert.equal(cli('undo', dir).code, 0);
  let status = cli('status', dir).json();
  assert.equal(status.tipKind, 'undo');
  assert.equal(status.canRedo, true);

  assert.equal(cli('redo', dir).code, 0);
  status = cli('status', dir).json();
  assert.equal(status.tipKind, 'redo');
  assert.equal(status.stateHash.length, 64);

  const verify = cli('verify', dir).json();
  assert.equal(verify.ok, true);
  assert.equal(verify.stateHash, status.stateHash);

  const snap = cli('snapshot', dir).json();
  assert.equal(snap.stateHash, status.stateHash);
});

test('CLI exit codes: E_BUDGET=10, E_PRECEDENCE=11, E_DIVERGED=13, E_CRC=12', () => {
  const dir = tmpdir();
  shop(dir);

  assert.equal(cli('budget', 'set', dir, '1').code, 0); // impossibly tight budget
  const budget = cli('schedule', dir);
  assert.equal(budget.code, 10);
  assert.match(budget.err, /E_BUDGET/);
  assert.equal(cli('budget', 'set', dir, 'null').code, 0);

  const prec = cli('dep', 'add', dir, 'W1:0', 'W1:1');
  assert.equal(prec.code, 11);
  assert.match(prec.err, /E_PRECEDENCE/);

  assert.equal(cli('undo', dir).code, 0); // undo the budget=null commit
  assert.equal(cli('machine', 'add', dir, 'M9', '--calendar', '0-10').code, 0); // diverge
  const diverged = cli('redo', dir);
  assert.equal(diverged.code, 13);
  assert.match(diverged.err, /E_DIVERGED/);

  // Corrupt a middle chunk of the journal, then verify must fail with E_CRC.
  const logPath = path.join(dir, 'journal.log');
  const buf = fs.readFileSync(logPath);
  buf[13] = buf[13] ^ 0xff;
  fs.writeFileSync(logPath, buf);
  const crc = cli('verify', dir);
  assert.equal(crc.code, 12);
  assert.match(crc.err, /E_CRC/);
});

test('CLI usage error exits with code 2', () => {
  assert.equal(cli('definitely-not-a-command').code, 2);
  assert.equal(cli().code, 2);
});
