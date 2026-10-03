// Acceptance 2: a quarantined batch propagating through multiple layers must
// fail with the complete conflict chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModel } from '../src/model.js';
import { solve } from '../src/solver.js';

const CHAIN_INPUT = {
  batches: [
    { id: 'M1', kind: 'material', quantity: 100, expiry: '2026-06-01', status: 'quarantined' },
    { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 10, loss: 0, expiry: '2026-05-01', candidates: ['M1'] },
    { id: 'P2', kind: 'production', line: 'L1', start: '2026-02-03', end: '2026-02-04', outputQty: 8, loss: 0, expiry: '2026-05-01', candidates: ['P1'] },
    { id: 'P3', kind: 'production', line: 'L1', start: '2026-02-05', end: '2026-02-06', outputQty: 5, loss: 0, expiry: '2026-05-01', candidates: ['P2'] },
  ],
};

test('multi-layer quarantine yields the full conflict chain', () => {
  const model = parseModel(CHAIN_INPUT);
  const result = solve(model);
  assert.equal(result.status, 'infeasible');
  assert.ok(result.proof.constraints.includes('no-quarantine'));
  const chains = result.proof.chains.map((c) => c.join('>'));
  assert.ok(
    chains.includes('M1>P1>P2>P3'),
    `expected full chain M1>P1>P2>P3, got ${JSON.stringify(result.proof.chains)}`,
  );
  for (const id of ['M1', 'P1', 'P2', 'P3']) {
    assert.ok(result.proof.batches.includes(id), `proof should involve ${id}`);
  }
  // Propagation conclusions: every layer is marked tainted.
  for (const id of ['M1', 'P1', 'P2', 'P3']) {
    assert.ok(result.derived.taint[id], `taint should propagate to ${id}`);
  }
});

test('a clean alternative avoids the quarantined candidate', () => {
  const input = {
    batches: [
      { id: 'MQ', kind: 'material', quantity: 100, expiry: '2026-06-01', status: 'quarantined' },
      { id: 'MG', kind: 'material', quantity: 100, expiry: '2026-06-01', status: 'released' },
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 10, loss: 0, expiry: '2026-05-01', candidates: ['MQ', 'MG'] },
    ],
  };
  const result = solve(parseModel(input));
  assert.equal(result.status, 'feasible');
  assert.deepEqual(result.edges, [{ parent: 'MG', child: 'P1', quantity: 10 }]);
});

test('indirect quarantine through a used production parent is rejected', () => {
  // P1 can be produced cleanly from M1, but P2's only extra candidate is the
  // quarantined MQ, so P2 must fail while P1 stays clean.
  const input = {
    batches: [
      { id: 'M1', kind: 'material', quantity: 50, expiry: '2026-06-01' },
      { id: 'MQ', kind: 'material', quantity: 50, expiry: '2026-06-01', status: 'quarantined' },
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 10, loss: 0, expiry: '2026-05-01', candidates: ['M1'] },
      { id: 'P2', kind: 'production', line: 'L1', start: '2026-02-03', end: '2026-02-04', outputQty: 40, loss: 0, expiry: '2026-05-01', candidates: ['P1', 'MQ'] },
    ],
  };
  const result = solve(parseModel(input));
  assert.equal(result.status, 'infeasible');
  assert.ok(result.proof.constraints.includes('no-quarantine'));
  const chains = result.proof.chains.map((c) => c.join('>'));
  assert.ok(chains.some((c) => c.includes('MQ') && c.includes('P2')));
});

test('expiry-order and line-non-overlap appear in proofs', () => {
  const expiryInput = {
    batches: [
      { id: 'M1', kind: 'material', quantity: 50, expiry: '2026-01-01' },
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-02', outputQty: 10, loss: 0, expiry: '2026-05-01', candidates: ['M1'] },
    ],
  };
  const r1 = solve(parseModel(expiryInput));
  assert.equal(r1.status, 'infeasible');
  assert.ok(r1.proof.constraints.includes('expiry-order'));

  const overlapInput = {
    batches: [
      { id: 'M1', kind: 'material', quantity: 100, expiry: '2026-06-01' },
      { id: 'P1', kind: 'production', line: 'L1', start: '2026-02-01', end: '2026-02-05', outputQty: 10, loss: 0, expiry: '2026-05-01', candidates: ['M1'] },
      { id: 'P2', kind: 'production', line: 'L1', start: '2026-02-03', end: '2026-02-06', outputQty: 10, loss: 0, expiry: '2026-05-01', candidates: ['M1'] },
    ],
  };
  const r2 = solve(parseModel(overlapInput));
  assert.equal(r2.status, 'infeasible');
  assert.ok(r2.proof.constraints.includes('line-non-overlap'));
  assert.deepEqual(r2.proof.overlaps[0].batches.sort(), ['P1', 'P2']);
});
