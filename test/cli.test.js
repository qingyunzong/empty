'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeTmp, csvContent, writeCsv, dirHash, runCli } = require('./helpers');

const D = '2026-06-01';

function run(args, opts = {}) {
  return runCli(args, opts);
}

test('CLI: diff → plan → apply → resolve 全链路', () => {
  const root = makeTmp();
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A);
  fs.mkdirSync(B);
  writeCsv(A, 'm001', D, 'CNY', csvContent('only-a'));
  writeCsv(B, 'm002', D, 'USD', csvContent('only-b'));

  // diff
  const d = run(['diff', '--a', A, '--b', B]);
  assert.strictEqual(d.status, 0, d.stderr);
  const diff = JSON.parse(d.stdout);
  assert.strictEqual(diff.changes.length, 2);
  assert.strictEqual(diff.errors.length, 0);

  // plan
  const planPath = path.join(root, 'plan.json');
  const p = run(['plan', '--a', A, '--b', B, '--out', planPath]);
  assert.strictEqual(p.status, 0, p.stderr);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.strictEqual(plan.stats.copies, 2);

  // apply
  const a = run(['apply', '--plan', planPath, '--journal', path.join(root, 'j.json')]);
  assert.strictEqual(a.status, 0, a.stderr);
  const summary = JSON.parse(a.stdout);
  assert.strictEqual(summary.copied, 2);
  assert.strictEqual(dirHash(A), dirHash(B));

  // resolve (无冲突 → resolved=0)
  const r = run(['resolve', '--a', A, '--b', B]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).resolved, 0);

  // 制造冲突 → apply 退出码 2 → resolve 后收敛
  writeCsv(A, 'm001', D, 'CNY', csvContent('conflict-a'));
  writeCsv(B, 'm001', D, 'CNY', csvContent('conflict-b'));
  const a2 = run(['apply', '--a', A, '--b', B, '--journal', path.join(root, 'j2.json')]);
  assert.strictEqual(a2.status, 2, `未解决冲突应以 2 退出: ${a2.stderr}`);
  const r2 = run(['resolve', '--a', A, '--b', B, '--strategy', 'keep-both']);
  assert.strictEqual(r2.status, 0, r2.stderr);
  assert.strictEqual(JSON.parse(r2.stdout).resolved, 1);
  assert.strictEqual(dirHash(A), dirHash(B));
});
