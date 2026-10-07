import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

test('CLI exec runs a JSONL file and prints per-step state and undoPlan', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'ops.jsonl');
  writeFileSync(file, [
    JSON.stringify({ op: 'deposit', account: 'a', amount: 100 }),
    JSON.stringify({ op: 'transfer', from: 'a', to: 'b', amount: 40 }),
    JSON.stringify({ op: 'freeze', account: 'b', amount: 30 }),
    JSON.stringify({ op: 'withdraw', account: 'a', amount: 9999 }),
    JSON.stringify({ op: 'undo' }),
    'not json',
  ].join('\n'));
  const { code, stdout, stderr } = runCli(['exec', file, '--budget', 'day=1000']);
  assert.equal(code, 0);
  assert.deepEqual(stderr, []);
  const lines = stdout.map((l) => JSON.parse(l));
  assert.equal(lines.length, 6);
  assert.equal(lines[0].step, 1);
  assert.equal(lines[0].status, 'ok');
  assert.equal(lines[0].state.budget, 1000);
  assert.equal(lines[0].undoPlan.target, 'U1');
  assert.equal(lines[1].state.accounts.b.balance, 40);
  assert.equal(lines[2].state.accounts.b.frozen, 30);
  assert.equal(lines[3].status, 'error');
  assert.equal(lines[3].error.code, 'INSUFFICIENT');
  assert.equal(lines[4].status, 'ok');
  assert.equal(lines[4].undone, 'U3');
  assert.equal(lines[4].undoPlan.status, 'EXECUTED');
  assert.equal(lines[5].status, 'error');
  assert.equal(lines[5].error.code, 'INVALID_INPUT');
});

test('CLI rejects bad usage, missing file and bad budget spec', () => {
  assert.equal(runCli([]).code, 2);
  assert.equal(runCli(['exec', 'no-such-file.jsonl']).code, 1);
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const file = join(dir, 'ops.jsonl');
  writeFileSync(file, '');
  assert.equal(runCli(['exec', file, '--budget', 'week=5']).code, 2);
  assert.equal(runCli(['exec', file, '--bogus']).code, 2);
});
