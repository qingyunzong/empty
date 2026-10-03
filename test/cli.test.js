import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from '../src/cli.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-cli-'));
}

function run(args) {
  let out = '';
  let err = '';
  const status = runCli(args, { stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
  return { status, stdout: out, stderr: err };
}

test('CLI: apply then balance round-trip', () => {
  const dir = tmpdir();
  const opsFile = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(
    opsFile,
    [
      JSON.stringify({ op: 'post', id: 'p1', account: 'alice', amount: 100, meta: { src: 'test' } }),
      JSON.stringify({ op: 'post', id: 'p2', account: 'alice', amount: -30 }),
      JSON.stringify({ op: 'reverse', id: 'p1', reason: 'refund' }),
      '',
    ].join('\n'),
  );
  const apply = run(['apply', opsFile, '--dir', dir]);
  assert.equal(apply.status, 0, apply.stderr);
  const results = apply.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(results.map((r) => r.seq), [1, 2, 3]);
  const bal = run(['balance', 'alice', '--dir', dir]);
  assert.equal(bal.status, 0, bal.stderr);
  assert.equal(JSON.parse(bal.stdout).balance, -30);
  const balAsOf = run(['balance', 'alice', '--as-of', '2', '--dir', dir]);
  assert.equal(JSON.parse(balAsOf.stdout).balance, 70);
});

test('CLI: apply is idempotent for repeated reverse across invocations', () => {
  const dir = tmpdir();
  const f1 = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f1, `${JSON.stringify({ op: 'post', id: 'x', account: 'bob', amount: 5 })}\n`);
  assert.equal(run(['apply', f1, '--dir', dir]).status, 0);
  const f2 = path.join(dir, 'b.jsonl');
  fs.writeFileSync(f2, `${JSON.stringify({ op: 'reverse', id: 'x' })}\n`);
  const first = run(['apply', f2, '--dir', dir]);
  assert.equal(first.status, 0, first.stderr);
  const again = run(['apply', f2, '--dir', dir]);
  assert.equal(again.status, 0, again.stderr);
  const r1 = JSON.parse(first.stdout.trim());
  const r2 = JSON.parse(again.stdout.trim());
  assert.equal(r1.seq, r2.seq);
  assert.equal(r2.idempotent, true);
});

test('CLI: errors exit non-zero with {code,message} on stderr', () => {
  const dir = tmpdir();
  const bad = run(['balance', 'alice', '--as-of', '99', '--dir', dir]);
  assert.notEqual(bad.status, 0);
  const parsed = JSON.parse(bad.stderr.trim());
  assert.equal(parsed.code, 'E_ARGS');
  assert.ok(typeof parsed.message === 'string');
  const opsFile = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(opsFile, `${JSON.stringify({ op: 'reverse', id: 'ghost' })}\n`);
  const failed = run(['apply', opsFile, '--dir', dir]);
  assert.notEqual(failed.status, 0);
  assert.equal(JSON.parse(failed.stderr.trim()).code, 'E_STATE');
  const noCmd = run(['frobnicate']);
  assert.notEqual(noCmd.status, 0);
  assert.equal(JSON.parse(noCmd.stderr.trim()).code, 'E_ARGS');
  const missing = run(['apply', path.join(dir, 'nope.jsonl'), '--dir', dir]);
  assert.notEqual(missing.status, 0);
  assert.equal(JSON.parse(missing.stderr.trim()).code, 'E_IO');
});

test('CLI: --no-negative rejects overdraft with E_STATE and keeps ledger intact', () => {
  const dir = tmpdir();
  const opsFile = path.join(dir, 'ops.jsonl');
  fs.writeFileSync(
    opsFile,
    [
      JSON.stringify({ op: 'post', id: 'in', account: 'alice', amount: 10 }),
      JSON.stringify({ op: 'post', id: 'out', account: 'alice', amount: -50 }),
      '',
    ].join('\n'),
  );
  const res = run(['apply', opsFile, '--dir', dir, '--no-negative']);
  assert.notEqual(res.status, 0);
  assert.equal(JSON.parse(res.stderr.trim()).code, 'E_STATE');
  const bal = run(['balance', 'alice', '--dir', dir]);
  assert.equal(JSON.parse(bal.stdout).balance, 10);
});
