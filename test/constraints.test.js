import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceStore } from '../src/store.js';
import { solve } from '../src/solve.js';
import { propagate } from '../src/propagate.js';

function storeWith(input) {
  const store = new TraceStore();
  store.applyTransaction(input);
  return store;
}

const M = (id, quantity, expiry = '2026-12-01', status = 'released') => ({ id, quantity, expiry, status });
const B = (id, candidates, overrides = {}) => ({
  id,
  line: 'L1',
  start: '2026-01-01T00:00:00Z',
  end: '2026-01-01T04:00:00Z',
  output: 10,
  loss: 2,
  expiry: '2026-06-01',
  candidates,
  ...overrides,
});

test('mass balance: inputs equal output plus fixed loss', () => {
  const store = storeWith({
    materials: [M('M1', 8), M('M2', 8)],
    batches: [B('P1', ['M1', 'M2'])],
  });
  const result = solve(store);
  assert.equal(result.status, 'feasible');
  const total = Object.values(result.assignment.P1).reduce((a, b) => a + b, 0);
  assert.equal(total, 12);
});

test('expiry order: parents expiring before the batch are excluded', () => {
  const store = storeWith({
    materials: [M('M1', 100, '2026-01-15'), M('M2', 100, '2026-12-01')],
    batches: [B('P1', ['M1', 'M2'])],
  });
  const prop = propagate(store);
  assert.equal(prop.domains.get('P1').get('M1').ub, 0);
  const result = solve(store);
  assert.deepEqual(result.assignment.P1, { M2: 12 });
});

test('line overlap on the same line is a contradiction', () => {
  const store = storeWith({
    materials: [M('M1', 100)],
    batches: [
      B('P1', ['M1']),
      B('P2', ['M1'], { start: '2026-01-01T02:00:00Z', end: '2026-01-01T06:00:00Z' }),
    ],
  });
  const result = solve(store);
  assert.equal(result.status, 'infeasible');
  assert.deepEqual(result.conflict.constraints, ['line-no-overlap']);
  assert.deepEqual([...result.conflict.batches].sort(), ['P1', 'P2']);
});

test('adjacent (non-overlapping) slots on one line are fine', () => {
  const store = storeWith({
    materials: [M('M1', 100)],
    batches: [
      B('P1', ['M1']),
      B('P2', ['M1'], { start: '2026-01-01T04:00:00Z', end: '2026-01-01T08:00:00Z' }),
    ],
  });
  assert.equal(solve(store).status, 'feasible');
});

test('supply limit: shared parent stock is a hard bound', () => {
  const store = storeWith({
    materials: [M('M1', 15)],
    batches: [B('P1', ['M1']), B('P2', ['M1'], { line: 'L2' })],
  });
  const result = solve(store);
  assert.equal(result.status, 'infeasible');
  assert.ok(result.conflict.constraints.includes('supply-limit'));
});

test('quantity domains tighten to availability and demand', () => {
  const store = storeWith({
    materials: [M('M1', 5), M('M2', 100)],
    batches: [B('P1', ['M1', 'M2'])],
  });
  const prop = propagate(store);
  const dom = prop.domains.get('P1');
  assert.deepEqual(dom.get('M1'), { lb: 0, ub: 5 });
  assert.deepEqual(dom.get('M2'), { lb: 7, ub: 12 });
});
