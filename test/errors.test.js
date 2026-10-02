import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basePolicy, baseStock, runCli } from './helpers.js';

const RUN_ARGS = ['run', '--defects', 'defects.jsonl', '--policy', 'policy.json',
  '--stock', 'stock.json', '--decisions', 'decision.jsonl', '--ledger', 'ledger.jsonl'];
const OUTPUTS = ['decision.jsonl', 'ledger.jsonl'];

function files({ policy, stock, defects }) {
  return {
    'policy.json': JSON.stringify(policy ?? basePolicy()),
    'stock.json': JSON.stringify(stock ?? baseStock()),
    'defects.jsonl': defects ?? '',
  };
}

test('negative stock exits with code 19', () => {
  const stock = baseStock();
  stock.items[0].onHand = -1;
  const result = runCli(files({ stock }), RUN_ARGS, OUTPUTS);
  assert.equal(result.status, 19);
  assert.match(result.stderr, /negative stock/);
});

test('unknown budget currency exits with code 20', () => {
  const policy = basePolicy();
  policy.rework.shiftBudget = { amount: 100, currency: 'BTC' };
  const result = runCli(files({ policy }), RUN_ARGS, OUTPUTS);
  assert.equal(result.status, 20);
  assert.match(result.stderr, /unknown budget currency/);
});

test('rework cost currency differing from budget currency exits with code 20', () => {
  const policy = basePolicy();
  policy.rework.costPerUnit = { amount: 10, currency: 'USD' };
  const result = runCli(files({ policy }), RUN_ARGS, OUTPUTS);
  assert.equal(result.status, 20);
});

test('duplicate defect id exits with code 21', () => {
  const defects = [
    { id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 100 },
    { id: 'D1', sku: 'SKU-A', customer: 'C2', amount: 200 },
  ].map((d) => JSON.stringify(d)).join('\n');
  const result = runCli(files({ defects }), RUN_ARGS, OUTPUTS);
  assert.equal(result.status, 21);
  assert.match(result.stderr, /duplicate defect id/);
});

test('happy path writes decision.jsonl and ledger.jsonl', () => {
  const defects = JSON.stringify({ id: 'D1', sku: 'SKU-E', customer: 'C1', amount: 300 });
  const result = runCli(files({ defects }), RUN_ARGS, OUTPUTS);
  assert.equal(result.status, 0, result.stderr);
  const decisions = readFileSync(result.paths['decision.jsonl'], 'utf8').trim().split('\n').map(JSON.parse);
  const ledger = readFileSync(result.paths['ledger.jsonl'], 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, 'rework');
  assert.equal(ledger[0].event, 'init');
});
