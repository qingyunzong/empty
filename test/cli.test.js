import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = new URL('../cli.js', import.meta.url).pathname;

function runCli(tradesDoc, ratesDoc) {
  const dir = mkdtempSync(join(tmpdir(), 'netclear-'));
  const tradesPath = join(dir, 'trades.json');
  const ratesPath = join(dir, 'rates.json');
  writeFileSync(tradesPath, JSON.stringify(tradesDoc));
  writeFileSync(ratesPath, JSON.stringify(ratesDoc));
  const proc = spawnSync(process.execPath, [CLI, tradesPath, ratesPath], { encoding: 'utf8' });
  return { status: proc.status, json: JSON.parse(proc.stdout), stdout: proc.stdout };
}

const RATES_DOC = {
  base: 'USD',
  versions: [
    { version: 1, rates: { USD: 1000000, EUR: 1100000 } },
    { version: 2, rates: { USD: 1000000, EUR: 1200000 } },
  ],
};

test('CLI settles and prints canonical JSON with proof', () => {
  const { status, json } = runCli(
    {
      trades: [{ id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 }],
      limits: { a: 200 },
    },
    RATES_DOC,
  );
  assert.equal(status, 0);
  assert.equal(json.status, 'ok');
  assert.deepEqual(json.netPositions, { a: -120, b: 120 });
  assert.deepEqual(json.locks, { a: 120 });
  assert.equal(json.proof.ratesVersion, 2);
  assert.equal(json.proof.rulesVersion, 'netting-rules/1.0.0');
  assert.match(json.proof.inputHash, /^[0-9a-f]{64}$/);
});

test('CLI output is byte-identical across runs', () => {
  const doc = {
    trades: [
      { id: 't1', from: 'a', to: 'b', ccy: 'EUR', amount: 100 },
      { id: 't2', from: 'b', to: 'a', ccy: 'USD', amount: 50 },
    ],
  };
  const r1 = runCli(doc, RATES_DOC);
  const r2 = runCli(doc, RATES_DOC);
  assert.equal(r1.stdout, r2.stdout);
});

test('CLI reports LIMIT with exit code 1', () => {
  const { status, json } = runCli(
    { trades: [{ id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 }], limits: { a: 50 } },
    RATES_DOC,
  );
  assert.equal(status, 1);
  assert.equal(json.status, 'error');
  assert.equal(json.error.code, 'LIMIT');
  assert.deepEqual(json.error.details, { limit: 50, participant: 'a', required: 100 });
});

test('CLI reports CYCLE_LOCKED with conflict set', () => {
  const { status, json } = runCli(
    {
      trades: [
        { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
        { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 100 },
        { id: 't3', from: 'c', to: 'a', ccy: 'USD', amount: 150 },
      ],
      limits: { a: 1000, b: 1000, c: 10 },
    },
    RATES_DOC,
  );
  assert.equal(status, 1);
  assert.equal(json.error.code, 'CYCLE_LOCKED');
  assert.deepEqual(json.error.details.conflictSet, ['t1', 't2', 't3']);
});

test('CLI rejects a stale requested rate version with RATE_STALE', () => {
  const { status, json } = runCli(
    { trades: [{ id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 1 }], ratesVersion: 1 },
    RATES_DOC,
  );
  assert.equal(status, 1);
  assert.equal(json.error.code, 'RATE_STALE');
});

test('CLI applies voids from trades.json', () => {
  const { status, json } = runCli(
    {
      trades: [
        { id: 't1', from: 'a', to: 'b', ccy: 'USD', amount: 100 },
        { id: 't2', from: 'b', to: 'c', ccy: 'USD', amount: 60 },
      ],
      void: ['t1'],
    },
    RATES_DOC,
  );
  assert.equal(status, 0);
  assert.deepEqual(json.locks, { b: 60 });
});

test('CLI exits 2 on unreadable input', () => {
  const proc = spawnSync(process.execPath, [CLI, '/nonexistent/trades.json', '/nonexistent/rates.json'], {
    encoding: 'utf8',
  });
  assert.equal(proc.status, 2);
  assert.equal(JSON.parse(proc.stdout).error.code, 'INVALID_INPUT');
});
