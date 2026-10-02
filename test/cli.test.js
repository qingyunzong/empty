import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cli-'));
}

function runCli(args) {
  const out = { stdout: '', stderr: '' };
  const code = main(args, {
    stdout: (s) => (out.stdout += s),
    stderr: (s) => (out.stderr += s),
  });
  return { code, ...out };
}

test('CLI prints result JSON for a confirmed call', () => {
  const dir = tmpdir();
  const eventFile = path.join(dir, 'event.json');
  fs.writeFileSync(
    eventFile,
    JSON.stringify({
      callId: 'cli-ok',
      targetAmount: 50,
      accounts: [
        { id: 'a', priority: 1, available: 30 },
        { id: 'b', priority: 2, available: 30 },
      ],
    }),
  );
  const proc = runCli([eventFile, path.join(dir, 'logs')]);
  assert.equal(proc.code, 0, proc.stderr);
  assert.equal(proc.stderr, '');
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, 'CONFIRMED');
  assert.equal(result.totalFrozen, 50);
  assert.equal(typeof result.certificate, 'string');
});

test('CLI accepts inline JSON and recovers from simulated crash', () => {
  const dir = tmpdir();
  const event = JSON.stringify({
    callId: 'cli-crash',
    targetAmount: 40,
    crashAfterAccount: 1,
    accounts: [
      { id: 'a', priority: 1, available: 25 },
      { id: 'b', priority: 2, available: 25 },
    ],
  });
  const proc = runCli([event, path.join(dir, 'logs')]);
  assert.equal(proc.code, 0, proc.stderr);
  const result = JSON.parse(proc.stdout);
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(result.freezes, [
    { accountId: 'a', amount: 25 },
    { accountId: 'b', amount: 15 },
  ]);

  const again = runCli([event, path.join(dir, 'logs')]);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.stdout), result);
});

test('CLI exits 1 with error JSON on stderr for invalid input', () => {
  const dir = tmpdir();
  const badJson = runCli(['{not json', path.join(dir, 'logs')]);
  assert.equal(badJson.code, 1);
  assert.equal(badJson.stdout, '');
  assert.ok(JSON.parse(badJson.stderr).error);

  const invalid = runCli([
    JSON.stringify({ callId: 'x', targetAmount: -5, accounts: [] }),
    path.join(dir, 'logs'),
  ]);
  assert.equal(invalid.code, 1);
  assert.match(JSON.parse(invalid.stderr).error, /targetAmount/);

  const noArgs = runCli([]);
  assert.equal(noArgs.code, 1);
  assert.ok(JSON.parse(noArgs.stderr).error);
});
