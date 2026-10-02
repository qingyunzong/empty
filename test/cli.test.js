import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oes-cli-'));
}

// Capture via files: piped stdio is unreliable in some sandboxed environments.
function run(dir, args, { input } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oes-cli-io-'));
  const outPath = path.join(tmp, 'out.txt');
  const errPath = path.join(tmp, 'err.txt');
  const inPath = path.join(tmp, 'in.txt');
  fs.writeFileSync(inPath, input ?? '');
  const outFd = fs.openSync(outPath, 'w');
  const errFd = fs.openSync(errPath, 'w');
  const inFd = fs.openSync(inPath, 'r');
  const r = spawnSync(process.execPath, [CLI, dir, ...args], {
    stdio: [inFd, outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  fs.closeSync(inFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outPath, 'utf8').trim(),
    stderr: fs.readFileSync(errPath, 'utf8').trim(),
  };
}

test('CLI end-to-end: append, query, undo, delete, merge, report', () => {
  const dir = tmpdir();
  const events = [
    { id: 'e1', tradeId: 'T1', fee: 10, refundBudget: 100, text: 'quick brown fox', state: 'open' },
    { id: 'e2', tradeId: 'T1', fee: 20, refundBudget: 100, text: 'quick red fox jumps', state: 'open' },
    { id: 'e3', tradeId: 'T2', fee: 5, refundBudget: 8, text: 'lazy dog sleeps', state: 'open' },
  ];

  let r = run(dir, ['append'], { input: events.map((e) => JSON.stringify(e)).join('\n') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { appended: 3 });

  r = run(dir, ['phrase', 'quick brown fox']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['e1']);

  r = run(dir, ['near', '2', 'fox', 'jumps']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['e2']);

  r = run(dir, ['undo', 'T1']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { tradeId: 'T1', refunded: 30, budget: 100, budgetRemaining: 70 });

  r = run(dir, ['delete', 'e2']);
  assert.equal(r.status, 0, r.stderr);
  r = run(dir, ['phrase', 'quick red fox']);
  assert.deepEqual(JSON.parse(r.stdout), []);

  r = run(dir, ['merge']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).segment, fs.readdirSync(dir).find((f) => f.startsWith('seg-')));

  r = run(dir, ['report']);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.trades.T1.refundedTotal, 30);
  assert.equal(report.trades.T1.budgetRemaining, 70);
});

test('CLI business errors exit with code 2 and agreed error codes', () => {
  const dir = tmpdir();
  run(dir, ['event', JSON.stringify({ id: 'e1', tradeId: 'T1', fee: 90, refundBudget: 50, text: 'x', state: 'open' })]);

  let r = run(dir, ['undo', 'T1']); // 90 > 50 budget
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ERROR INSUFFICIENT_BUDGET/);

  r = run(dir, ['undo', 'GHOST']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ERROR UNKNOWN_TRADE/);

  r = run(dir, ['delete', 'GHOST']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ERROR NOT_FOUND/);

  // Failed undo left state untouched.
  r = run(dir, ['report']);
  assert.equal(JSON.parse(r.stdout).trades.T1.refundedTotal, 0);
});
