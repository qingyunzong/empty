import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { runEngine } from '../src/engine.js';

const accounts = [
  { id: 'A1', priority: 2, liquidationLine: 1000, deadlineSlot: 2, cash: 0, position: 10 },
  { id: 'A2', priority: 1, liquidationLine: 800, deadlineSlot: 2, cash: 0, position: 5 },
];
const ticks = [
  { accountId: 'A1', price: 90, version: 1 },
  { accountId: 'A1', price: 70, version: 2 },
  { accountId: 'A2', price: 100, version: 1 },
  { op: 'undo', accountId: 'A1', version: 2 },
  { accountId: 'A2', price: 50, version: 0 }, // stale
];

function writeInputs() {
  const dir = mkdtempSync(join(tmpdir(), 'mce-'));
  const ticksPath = join(dir, 'ticks.json');
  const accountsPath = join(dir, 'accounts.json');
  writeFileSync(ticksPath, JSON.stringify(ticks));
  writeFileSync(
    accountsPath,
    JSON.stringify({ accounts, config: { slots: 2, slotCapacity: 1 } }),
  );
  return { ticksPath, accountsPath };
}

test('CLI: reads ticks.json + accounts.json and prints calls, rolledBack, proof', () => {
  const { ticksPath, accountsPath } = writeInputs();
  let out = '';
  let err = '';
  const code = runCli([ticksPath, accountsPath], { out: (s) => (out += s), err: (s) => (err += s) });
  assert.equal(code, 0, err);
  const result = JSON.parse(out);

  assert.equal(result.calls.length, 2);
  assert.deepEqual(result.rolledBack, [{ accountId: 'A1', fromVersion: 2, toVersion: 1 }]);
  assert.deepEqual(result.errors, [{ code: 'STALE_TICK', accountId: 'A2', version: 0 }]);
  assert.equal(result.calls.find((c) => c.accountId === 'A1').gap, 100);
  assert.match(result.proof.seed, /^[0-9a-f]{16}$/);
  assert.match(result.proof.scheduleHash, /^[0-9a-f]{64}$/);

  // CLI output matches the library on identical input.
  const lib = runEngine(accounts, ticks, { slots: 2, slotCapacity: 1 });
  assert.equal(result.proof.scheduleHash, lib.proof.scheduleHash);
});

test('CLI: --slots flag overrides config file', () => {
  const { ticksPath, accountsPath } = writeInputs();
  let out = '';
  const code = runCli([ticksPath, accountsPath, '--slots', '1'], {
    out: (s) => (out += s),
    err: () => {},
  });
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.proof.slots, 1);
  // Only one slot: higher-priority A1 wins, A2 is preempted.
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].accountId, 'A1');
  assert.deepEqual(result.errors.slice(-1), [
    { code: 'NO_CAPACITY', accountId: 'A2', preemptedBy: 'A1' },
  ]);
});

test('CLI: usage error on missing arguments', () => {
  let err = '';
  const code = runCli([], { out: () => {}, err: (s) => (err += s) });
  assert.equal(code, 2);
  assert.match(err, /Usage:/);
});
