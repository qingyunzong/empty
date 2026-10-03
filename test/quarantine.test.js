import assert from 'node:assert/strict';
import test from 'node:test';
import { TraceStore } from '../src/store.js';
import { solve } from '../src/solve.js';

function storeWith(input) {
  const store = new TraceStore();
  store.applyTransaction(input);
  return store;
}

const B = (id, candidates, startHour) => ({
  id,
  line: 'L1',
  start: `2026-01-01T${String(startHour).padStart(2, '0')}:00:00Z`,
  end: `2026-01-01T${String(startHour + 2).padStart(2, '0')}:00:00Z`,
  output: 10,
  loss: 0,
  expiry: '2026-06-01',
  candidates,
});

test('quarantine propagates through multiple layers with a full conflict chain', () => {
  const store = storeWith({
    materials: [{ id: 'M0', quantity: 100, expiry: '2026-12-01', status: 'quarantined' }],
    batches: [B('P0', ['M0'], 0), B('P1', ['P0'], 4), B('P2', ['P1'], 8)],
  });
  const result = solve(store);
  assert.equal(result.status, 'infeasible');
  const { conflict } = result;
  assert.ok(conflict.constraints.includes('quarantine-closure'));
  assert.ok(conflict.constraints.includes('mass-balance'));
  // Full chain: quarantined source first, then each derived layer in order.
  assert.deepEqual(
    conflict.chain.map((c) => c.batch),
    ['M0', 'P0', 'P1', 'P2'],
  );
  assert.equal(conflict.chain[0].rule, 'quarantined');
  for (const step of conflict.chain.slice(1)) {
    assert.equal(step.rule, 'insufficient-clean-supply');
    assert.equal(step.cleanSupply, 0);
  }
  assert.deepEqual([...conflict.batches].sort(), ['M0', 'P0', 'P1', 'P2']);
});

test('mixed shortage: clean supply exists but cannot cover the deficit', () => {
  const store = storeWith({
    materials: [
      { id: 'M0', quantity: 100, expiry: '2026-12-01', status: 'quarantined' },
      { id: 'M1', quantity: 4, expiry: '2026-12-01' },
    ],
    batches: [B('P0', ['M0', 'M1'], 0), B('P1', ['P0'], 4)],
  });
  const result = solve(store);
  assert.equal(result.status, 'infeasible');
  const p0 = result.conflict.chain.find((c) => c.batch === 'P0');
  assert.equal(p0.needed, 10);
  assert.equal(p0.cleanSupply, 4);
  assert.deepEqual(p0.blockedParents, ['M0']);
  // The blockage must still reach the downstream batch.
  assert.deepEqual(result.conflict.chain.map((c) => c.batch), ['M0', 'P0', 'P1']);
});

test('released sibling keeps the instance feasible despite a quarantined lot', () => {
  const store = storeWith({
    materials: [
      { id: 'M0', quantity: 100, expiry: '2026-12-01', status: 'quarantined' },
      { id: 'M1', quantity: 100, expiry: '2026-12-01' },
    ],
    batches: [B('P0', ['M0', 'M1'], 0)],
  });
  const result = solve(store);
  assert.equal(result.status, 'feasible');
  assert.deepEqual(result.assignment.P0, { M1: 10 });
});
