import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

// The sandbox forbids spawning child processes, so the CLI is driven
// in-process via run(argv, io); exit code and stdout/stderr are captured.
const runCli = (ops, asOf = '2026-10-15') => {
  const dir = mkdtempSync(join(tmpdir(), 'refund-cli-'));
  const file = join(dir, 'ops.jsonl');
  writeFileSync(file, ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  let stdout = '';
  let stderr = '';
  const status = run(['apply', file, '--as-of', asOf], { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } });
  return { status, stdout, stderr };
};

const ORDER = {
  op: 'order',
  order: {
    orderId: 'o1', merchantId: 'm1', discount: 100, pointsRate: 0.01,
    lines: [
      { lineId: 'l1', amount: 1000, taxRate: 0.1 },
      { lineId: 'l2', amount: 3000, taxRate: 0.1 },
    ],
  },
};

test('CLI: happy path applies ops and reports JSONL results on stdout', () => {
  const r = runCli([
    ORDER,
    { op: 'budget', merchantId: 'm1', period: '2026-10', limit: 100000 },
    { op: 'refund', refId: 'r1', orderId: 'o1', lines: [{ lineId: 'l1', amount: 400 }], date: '2026-10-01' },
    { op: 'refund', refId: 'r2', orderId: 'o1', lines: [{ lineId: 'l2', amount: 900 }], date: '2026-10-02' },
    { op: 'revoke', refId: 'r1' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(out.map((o) => [o.op, o.status]), [['order', 'ok'], ['budget', 'ok'], ['refund', 'ok'], ['refund', 'ok'], ['revoke', 'ok']]);
  assert.deepEqual(out[4].revoked, ['r1', 'r2']);
  assert.ok(out[2].effects.length === 1 && out[2].effects[0].lineId === 'l1');
});

test('CLI: --as-of skips ops dated in the future', () => {
  const r = runCli([
    ORDER,
    { op: 'refund', refId: 'r1', orderId: 'o1', lines: [{ lineId: 'l1', amount: 100 }], date: '2026-10-01' },
    { op: 'refund', refId: 'r2', orderId: 'o1', lines: [{ lineId: 'l1', amount: 100 }], date: '2026-12-01' },
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(out.map((o) => o.op), ['order', 'refund']);
});

test('CLI: budget exceeded -> exit!=0 and stderr {code,message}', () => {
  const r = runCli([
    ORDER,
    { op: 'budget', merchantId: 'm1', period: '2026-10', limit: 10 },
    { op: 'refund', refId: 'r1', orderId: 'o1', lines: [{ lineId: 'l1', amount: 400 }], date: '2026-10-01' },
  ]);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.code, 'E_BUDGET_EXCEEDED');
  assert.equal(typeof err.message, 'string');
});

test('CLI: settled revoke with reverse -> exit!=0, stderr carries reversal', () => {
  const r = runCli([
    ORDER,
    { op: 'refund', refId: 'r1', orderId: 'o1', lines: [{ lineId: 'l1', amount: 400 }], date: '2026-10-01' },
    { op: 'settle', refId: 'r1' },
    { op: 'revoke', refId: 'r1', reverse: true },
  ]);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.code, 'E_ALREADY_SETTLED');
  assert.equal(err.reversal.revId, 'r1:rev');
  assert.ok(err.reversal.gross < 0);
});

test('CLI: rollback path error surfaces path on stderr', () => {
  const r = runCli([
    ORDER,
    { op: 'refund', refId: 'r1', orderId: 'o1', lines: [{ lineId: 'l1', amount: 100 }], date: '2026-10-01' },
    { op: 'refund', refId: 'r2', orderId: 'o1', lines: [{ lineId: 'l2', amount: 100 }], date: '2026-10-02' },
    { op: 'settle', refId: 'r2' },
    { op: 'revoke', refId: 'r1' },
  ]);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.code, 'E_ROLLBACK_PATH');
  assert.deepEqual(err.path, ['r1', 'r2']);
});

test('CLI: usage error exits non-zero with E_USAGE', () => {
  let stderr = '';
  const status = run(['apply'], { stdout: () => {}, stderr: (s) => { stderr += s; } });
  assert.equal(status, 2);
  assert.equal(JSON.parse(stderr.trim()).code, 'E_USAGE');
});
