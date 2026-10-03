// CLI tests run the pure runCli() core in-process (the sandbox forbids
// spawning child processes); cli.js is a thin wrapper mapping the returned
// code onto process.exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cliMain.js';

const example = (name) => new URL(`../examples/${name}`, import.meta.url).pathname;

test('check overlapping-reads: exit 0, linearizable true, witness printed', () => {
  const r = runCli(['check', example('overlapping-reads.json'), '--initial-balance', '100']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.linearizable, true);
  assert.deepEqual(out.order, ['read-old', 'res1', 'read-new']);
  console.log(`CLI WITNESS overlapping-reads: ${JSON.stringify(out.order)}`);
});

test('check cancel-then-commit: exit 0, linearizable false with reason', () => {
  const r = runCli(['check', example('cancel-then-commit.json'), '--initial-balance', '100']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.linearizable, false);
  assert.match(out.reason, /no sequential ordering/);
  console.log(`CLI CONFLICT cancel-then-commit: ${out.reason}`);
});

test('check invalid negative amount: exit 1 with INVALID_HISTORY', () => {
  const r = runCli(['check', example('invalid-negative.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INVALID_HISTORY/);
});

test('check time inversion: exit 1 with INVALID_HISTORY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txn-'));
  const file = join(dir, 'bad.json');
  writeFileSync(file, JSON.stringify([
    { client: 'c', opId: 'x', invocationTime: 9, responseTime: 3, type: 'reserve', account: 'a', amount: 1, reserveId: 'r' },
  ]));
  const r = runCli(['check', file]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INVALID_HISTORY.*time inversion/);
});

test('check duplicate opId (duplicate response): exit 1 with INVALID_HISTORY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txn-'));
  const file = join(dir, 'dup.json');
  writeFileSync(file, JSON.stringify([
    { client: 'c', opId: 'x', invocationTime: 0, responseTime: 1, type: 'reserve', account: 'a', amount: 1, reserveId: 'r' },
    { client: 'c', opId: 'x', invocationTime: 2, responseTime: 3, type: 'cancel', account: 'a', reserveId: 'r' },
  ]));
  const r = runCli(['check', file]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INVALID_HISTORY.*duplicate opId/);
});

test('check unparseable file: exit 1 with INVALID_HISTORY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txn-'));
  const file = join(dir, 'junk.json');
  writeFileSync(file, 'not json{');
  const r = runCli(['check', file]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /INVALID_HISTORY/);
});

test('check zero-amount cycle: exit 0, linearizable true', () => {
  const r = runCli(['check', example('zero-amount-cycle.json'), '--initial-balance', '100']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.linearizable, true);
  console.log(`CLI WITNESS zero-amount-cycle: ${JSON.stringify(out.order)}`);
});

test('usage error: exit 2', () => {
  assert.equal(runCli(['nope']).code, 2);
  assert.equal(runCli(['check']).code, 2);
  assert.equal(runCli(['check', example('zero-amount-cycle.json'), '--initial-balance', '-3']).code, 2);
});
