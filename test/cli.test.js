import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../bin/cli.js';
import { tmpdir } from './helpers.js';

function run(dir, args) {
  let stdout = '';
  let stderr = '';
  const code = main(['--dir', dir, ...args], {
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
  });
  return { code, stdout, stderr };
}

function runOk(dir, args) {
  const result = run(dir, args);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('cli append/query/delete/undo/merge/stats round trip', () => {
  const dir = tmpdir();
  runOk(dir, ['append', JSON.stringify({ id: 'e1', tradeId: 't1', fee: 12, refundBudget: 50, text: 'new york city', state: 'open' })]);
  runOk(dir, ['append', JSON.stringify({ id: 'e2', tradeId: 't1', fee: 8, refundBudget: 50, text: 'new jersey turnpike', state: 'open' })]);
  runOk(dir, ['append', JSON.stringify({ id: 'e3', tradeId: 't2', fee: 99, refundBudget: 10, text: 'york new amsterdam', state: 'open' })]);
  assert.deepEqual(runOk(dir, ['phrase', 'new york']), { ids: ['e1'] });
  assert.deepEqual(runOk(dir, ['near', 'new', 'york', '--window', '2']), { ids: ['e1', 'e3'] });
  const overBudget = run(dir, ['undo', 't2']);
  assert.equal(overBudget.code, 1);
  assert.match(overBudget.stderr, /ERR_BUDGET_EXCEEDED/);
  runOk(dir, ['delete', 'e3']);
  assert.deepEqual(runOk(dir, ['near', 'new', 'york', '--window', '2']), { ids: ['e1'] });
  const undo = runOk(dir, ['undo', 't1']);
  assert.deepEqual(undo, { tradeId: 't1', refunded: 20, budgetRemaining: 30 });
  const unknown = run(dir, ['undo', 'nope']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /ERR_UNKNOWN_TRADE/);
  const merged = runOk(dir, ['merge']);
  assert.equal(merged.live, 2);
  const stats = runOk(dir, ['stats']);
  assert.equal(stats.live, 2);
  assert.equal(stats.refunds.length, 1);
  assert.equal(stats.refunds[0].tradeId, 't1');
});
