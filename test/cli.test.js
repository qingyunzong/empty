// CLI: refund apply ops.jsonl --as-of <date>
// Errors exit non-zero and print {code,message} JSON to stderr.
// (Tested in-process via the exported run() to avoid spawning subprocesses.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

function runCli(opsText, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'refund-'));
  const file = join(dir, 'ops.jsonl');
  writeFileSync(file, opsText);
  let stdout = '';
  let stderr = '';
  const status = run(['apply', file, ...args], {
    stdout: (s) => (stdout += s),
    stderr: (s) => (stderr += s),
  });
  return { status, stdout, stderr };
}

const ORDER = {
  orderId: 'o1',
  merchantId: 'm1',
  discount: 100,
  lines: [
    { lineId: 'a', amount: 1000, taxRateBps: 1000, points: 5 },
    { lineId: 'b', amount: 2000, taxRateBps: 1000, points: 15 },
  ],
};

test('apply processes ops and prints records as JSONL, exit 0', () => {
  const ops = [
    JSON.stringify({ op: 'budget', merchantId: 'm1', limit: 100000, period: 'monthly' }),
    JSON.stringify({ op: 'refund', refId: 'r1', order: ORDER, lines: ['a'], date: '2026-01-10', settleDays: 90 }),
    JSON.stringify({ op: 'refund', refId: 'r2', order: { orderId: 'o1', merchantId: 'm1' }, lines: ['b'], date: '2026-01-11', settleDays: 90 }),
    JSON.stringify({ op: 'revoke', refId: 'r1' }),
  ].join('\n');
  const res = runCli(ops, ['--as-of', '2026-02-01']);
  assert.equal(res.status, 0, res.stderr);
  const records = res.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((r) => r.type), ['budget', 'refund', 'refund', 'revoke']);
  assert.equal(records[1].status, 'pending');
  assert.deepEqual(records[3].rolledBack, ['r2', 'r1']); // hierarchical rollback
});

test('op error: exit != 0 and stderr carries {code,message}', () => {
  const ops = [
    JSON.stringify({ op: 'budget', merchantId: 'm1', limit: 10, period: 'monthly' }),
    JSON.stringify({ op: 'refund', refId: 'r1', order: ORDER, lines: ['a'], date: '2026-01-10' }),
  ].join('\n');
  const res = runCli(ops, ['--as-of', '2026-02-01']);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr.trim());
  assert.equal(err.code, 'E_BUDGET_EXCEEDED');
  assert.equal(typeof err.message, 'string');
});

test('settled revoke via CLI: stderr error plus optional reverse flow on stdout', () => {
  const ops = [
    JSON.stringify({ op: 'refund', refId: 'r1', order: ORDER, lines: ['a'], date: '2026-01-01', settleDays: 1 }),
    JSON.stringify({ op: 'revoke', refId: 'r1', reverse: true }),
  ].join('\n');
  const res = runCli(ops, ['--as-of', '2026-02-01']);
  assert.notEqual(res.status, 0);
  const err = JSON.parse(res.stderr.trim());
  assert.equal(err.code, 'E_ALREADY_SETTLED');
  const records = res.stdout.trim().split('\n').map(JSON.parse);
  const reversal = records.find((r) => r.type === 'reversal');
  assert.ok(reversal, 'expected a reversal record on stdout');
  assert.equal(reversal.parentRefId, 'r1');
  assert.ok(reversal.total < 0);
});

test('usage errors and bad input exit non-zero', () => {
  let stderr = '';
  const noArgs = run([], { stdout: () => {}, stderr: (s) => (stderr += s) });
  assert.notEqual(noArgs, 0);
  assert.equal(JSON.parse(stderr.trim()).code, 'E_USAGE');

  stderr = '';
  const missing = run(['apply', '/no/such/file.jsonl'], { stdout: () => {}, stderr: (s) => (stderr += s) });
  assert.notEqual(missing, 0);
  assert.equal(JSON.parse(stderr.trim()).code, 'E_IO');

  const badDate = runCli('', ['--as-of', 'not-a-date']);
  assert.notEqual(badDate.status, 0);
  assert.equal(JSON.parse(badDate.stderr.trim()).code, 'E_INVALID_DATE');

  const badJson = runCli('{not json}\n');
  assert.notEqual(badJson.status, 0);
  assert.equal(JSON.parse(badJson.stderr.trim()).code, 'E_INVALID_OP');
});
