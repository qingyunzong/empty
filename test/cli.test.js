import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

// Note: the sandbox blocks child-process spawning, so the CLI is exercised
// in-process through run(argv, io) — the same entry bin/card.js uses.
function runCli(args) {
  let stdout = '';
  let stderr = '';
  const status = run(args, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { status, stdout, stderr };
}

function writeEvents(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'card-'));
  const file = join(dir, 'events.jsonl');
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

test('CLI: apply events then query stats for a merchant/day', () => {
  const file = writeEvents([
    { type: 'auth', id: 't1', merchant: 'm', day: '2024-04-01', amount: 100, currency: 'USD', tip: null },
    { type: 'capture', id: 't1', day: '2024-04-01' },
    { type: 'auth', id: 't2', merchant: 'm', day: '2024-04-01', amount: 200, currency: 'XAU', tip: 20 },
    { type: 'capture', id: 't2', day: '2024-04-01' },
  ]);
  const res = runCli(['apply', file, '--stats', 'm', '2024-04-01']);
  assert.equal(res.status, 0, res.stderr);
  const stats = JSON.parse(res.stdout);
  assert.deepEqual(stats.currencies.USD, { count: 1, min: 100, max: 100, sum: 100 });
  assert.deepEqual(stats.currencies.XAU, { count: 1, min: 220, max: 220, sum: 220 });
  assert.equal(stats.totalUsd, 100);
});

test('CLI: illegal transition exits non-zero with {code,message} on stderr', () => {
  const file = writeEvents([
    { type: 'auth', id: 't1', merchant: 'm', day: '2024-04-01', amount: 100, currency: 'USD' },
    { type: 'refund', id: 't1' },
  ]);
  const res = runCli(['apply', file]);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr);
  assert.equal(err.code, 'E_TRANSITION');
  assert.ok(typeof err.message === 'string' && err.message.length > 0);
  assert.equal(res.stdout, '');
});

test('CLI: settlement-locked chargeback reversal exits non-zero with E_LOCKED', () => {
  const file = writeEvents([
    { type: 'auth', id: 't1', merchant: 'm', day: '2024-04-01', amount: 100, currency: 'USD' },
    { type: 'capture', id: 't1', day: '2024-04-02' },
    { type: 'chargeback', id: 't1' },
    { type: 'settle', merchant: 'm', day: '2024-04-30' },
    { type: 'reverse_chargeback', id: 't1' },
  ]);
  const res = runCli(['apply', file]);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_LOCKED');
});

test('CLI: missing file, bad JSON and bad usage are structured errors', () => {
  const missing = runCli(['apply', '/nonexistent/events.jsonl']);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stderr).code, 'E_IO');

  const dir = mkdtempSync(join(tmpdir(), 'card-'));
  const bad = join(dir, 'bad.jsonl');
  writeFileSync(bad, '{"type":"auth"\n');
  const res = runCli(['apply', bad]);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr).code, 'E_VALIDATION');

  const usage = runCli(['bogus']);
  assert.notEqual(usage.status, 0);
  assert.equal(JSON.parse(usage.stderr).code, 'E_USAGE');
});
