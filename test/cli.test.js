import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cliMain.js';

// Drives the same code path as cli.js (thin wrapper around runCli).
function runCliWithFiles(tradesDoc, ratesDoc) {
  const dir = mkdtempSync(join(tmpdir(), 'netclear-'));
  const tradesPath = join(dir, 'trades.json');
  const ratesPath = join(dir, 'rates.json');
  writeFileSync(tradesPath, JSON.stringify(tradesDoc));
  writeFileSync(ratesPath, JSON.stringify(ratesDoc));
  const { status, stdout } = runCli([tradesPath, ratesPath]);
  return { status, stdout, json: JSON.parse(stdout) };
}

const ratesDoc = {
  base: 'USD',
  versions: [
    { version: 1, rates: { EUR: '1.10' } },
    { version: 2, rates: { EUR: '1.20' } },
  ],
};

test('CLI settles trades and prints JSON result on stdout', () => {
  const tradesDoc = {
    ratesVersion: 2,
    limits: { A: '500', B: '500', C: '500' },
    trades: [
      { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' },
      { id: 't2', from: 'B', to: 'C', currency: 'EUR', amount: '50' },
      { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '60' },
    ],
  };
  const { status, json } = runCliWithFiles(tradesDoc, ratesDoc);
  assert.equal(status, 0);
  assert.equal(json.ok, true);
  // Cycle A->B(100) B->C(60) C->A(60): bottleneck 60 nets out, A owes B 40.
  assert.deepEqual(json.netObligations, [
    { from: 'A', to: 'B', amount: '40', trades: ['t1', 't2', 't3'] },
  ]);
  assert.equal(json.locks.find((l) => l.party === 'A').locked, '40');
  assert.match(json.proof.inputHash, /^[0-9a-f]{64}$/);
  assert.equal(json.proof.rulesVersion, 'netting-rules/1.0.0');
  assert.equal(json.proof.ratesVersion, 2);
});

test('CLI reports RATE_STALE as JSON with non-zero exit code', () => {
  const tradesDoc = {
    ratesVersion: 1, // stale: current is 2
    trades: [{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '1' }],
  };
  const { status, json } = runCliWithFiles(tradesDoc, ratesDoc);
  assert.equal(status, 1);
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'RATE_STALE');
  assert.equal(json.error.requested, 1);
  assert.equal(json.error.current, 2);
});

test('CLI reports CYCLE_LOCKED with minimal conflict set', () => {
  const tradesDoc = {
    ratesVersion: 2,
    limits: { A: '50', B: '10', C: '50' },
    trades: [
      { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '50' },
      { id: 't2', from: 'B', to: 'C', currency: 'USD', amount: '50' },
      { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '50' },
    ],
  };
  const { status, json } = runCliWithFiles(tradesDoc, ratesDoc);
  assert.equal(status, 1);
  assert.equal(json.error.code, 'CYCLE_LOCKED');
  assert.deepEqual(json.error.cycle, ['A', 'B', 'C']);
  assert.deepEqual(json.error.conflict.parties, [{ party: 'B', required: '50', available: '10' }]);
  assert.deepEqual(json.error.conflict.trades, ['t1', 't2', 't3']);
});

test('CLI reports LIMIT at the clearing window boundary', () => {
  const tradesDoc = {
    ratesVersion: 2,
    windowCapacity: '99.999999',
    trades: [{ id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' }],
  };
  const { status, json } = runCliWithFiles(tradesDoc, ratesDoc);
  assert.equal(status, 1);
  assert.equal(json.error.code, 'LIMIT');
  assert.equal(json.error.scope, 'window');
});

test('CLI output is deterministic across runs', () => {
  const tradesDoc = {
    ratesVersion: 2,
    limits: { A: '500', B: '500', C: '500' },
    trades: [
      { id: 't3', from: 'C', to: 'A', currency: 'USD', amount: '60' },
      { id: 't1', from: 'A', to: 'B', currency: 'USD', amount: '100' },
      { id: 't2', from: 'B', to: 'C', currency: 'EUR', amount: '50' },
    ],
  };
  const a = runCliWithFiles(tradesDoc, ratesDoc);
  const b = runCliWithFiles(tradesDoc, ratesDoc);
  assert.equal(a.stdout, b.stdout);
});
