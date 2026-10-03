import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

// Acceptance 3: crash after PREPARE; on recovery the account available quota
// is unchanged and a fresh freeze succeeds.

function runCli(args, dir) {
  return spawnSync(process.execPath, [CLI, ...args, '--db', dir], { encoding: 'utf8' });
}

test('PREPARED-then-crash recovery: available unchanged, re-freeze succeeds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freezedb-'));

  let res = runCli(['freeze', 'A', '100'], dir);
  assert.equal(res.status, 0, res.stderr);
  const { freezeId } = JSON.parse(res.stdout);
  assert.ok(freezeId);

  res = runCli(['query', 'A'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { account: 'A', balance: 1000, frozen: 100, available: 900 });

  // Crash after writing PREPARE for a 200 freeze (no COMMIT).
  res = runCli(['crash', '--prepared', '--account', 'A', '--amount', '200'], dir);
  assert.equal(res.status, 2, `expected simulated crash exit, got ${res.status}: ${res.stderr}`);
  assert.match(res.stderr, /crash after PREPARE/);
  const wal = fs.readFileSync(path.join(dir, 'wal.log'), 'utf8');
  const records = wal.trim().split('\n').map((l) => JSON.parse(l));
  const last = records[records.length - 1];
  assert.equal(last.type, 'PREPARE');
  assert.ok(!records.some((r) => r.type === 'COMMIT' && r.txid === last.txid), 'no COMMIT for crashed tx');

  // Recovery: the uncommitted freeze must not take effect.
  res = runCli(['query', 'A'], dir);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), { account: 'A', balance: 1000, frozen: 100, available: 900 });

  // Lock table was cleared by the crash: re-freezing the same amount succeeds.
  res = runCli(['freeze', 'A', '200'], dir);
  assert.equal(res.status, 0, res.stderr);
  res = runCli(['query', 'A'], dir);
  assert.deepEqual(JSON.parse(res.stdout), { account: 'A', balance: 1000, frozen: 300, available: 700 });
});

test('cancel releases the freeze inside a transaction (CLI)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freezedb-'));
  let res = runCli(['freeze', 'B', '400', '--priority', '5'], dir);
  assert.equal(res.status, 0, res.stderr);
  const { freezeId } = JSON.parse(res.stdout);

  res = runCli(['cancel', freezeId], dir);
  assert.equal(res.status, 0, res.stderr);

  res = runCli(['query', 'B'], dir);
  assert.deepEqual(JSON.parse(res.stdout), { account: 'B', balance: 1000, frozen: 0, available: 1000 });
});
