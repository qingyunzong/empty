// Acceptance 4: budget exhaustion yields PENDING (never UNSAT), charged
// separately per propagation step and per backtrack node, keeping the facts
// propagated so far.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';

// Instance that needs both propagation and backtracking to solve.
function buildChainEngine() {
  const e = new Engine({ coordBins: 6, magBins: 1, capacity: 4 });
  e.applyEvent({ type: 'add_obs', id: 'a1', star: 'A', night: 1, ts: 1, coord: 1, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'b1', star: 'B', night: 1, ts: 1, coord: 2, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'b2', star: 'B', night: 1, ts: 2, coord: 3, mag: 0, conf: 0.8 });
  e.applyEvent({ type: 'add_obs', id: 'c1', star: 'C', night: 1, ts: 1, coord: 3, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'c2', star: 'C', night: 1, ts: 2, coord: 4, mag: 0, conf: 0.8 });
  e.applyEvent({ type: 'add_obs', id: 'd1', star: 'D', night: 1, ts: 1, coord: 4, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'd2', star: 'D', night: 1, ts: 2, coord: 5, mag: 0, conf: 0.8 });
  return e;
}

// Instance that is genuinely UNSAT (two stars forced onto one cell).
function buildUnsatEngine() {
  const e = new Engine({ coordBins: 1, magBins: 1, capacity: 2 });
  e.applyEvent({ type: 'add_obs', id: 'o1', star: 's1', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 });
  e.applyEvent({ type: 'add_obs', id: 'o2', star: 's2', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 });
  return e;
}

test('budgets are charged separately: exact budget solves, one less is PENDING', () => {
  const full = buildChainEngine().applyEvent({ type: 'solve' });
  assert.equal(full.status, 'SAT');
  const P = full.stats.propagation;
  const B = full.stats.backtrack;
  assert.ok(P > 0 && B > 0, `expected mixed workload, got ${JSON.stringify(full.stats)}`);

  const exact = buildChainEngine().applyEvent({ type: 'solve', budget: { propagation: P, backtrack: B } });
  assert.equal(exact.status, 'SAT');
  assert.deepEqual(exact.cells, full.cells);

  const underProp = buildChainEngine().applyEvent({ type: 'solve', budget: { propagation: P - 1, backtrack: B } });
  assert.equal(underProp.status, 'PENDING');
  assert.equal(underProp.reason, 'BUDGET_EXCEEDED');
  assert.equal(underProp.exceeded, 'propagation');
  assert.ok(!('unsatCore' in underProp), 'PENDING must not carry an UNSAT core');
  assert.ok(underProp.partial, 'propagated facts are retained');

  const underBt = buildChainEngine().applyEvent({ type: 'solve', budget: { propagation: P, backtrack: B - 1 } });
  assert.equal(underBt.status, 'PENDING');
  assert.equal(underBt.exceeded, 'backtrack');
});

test('UNSAT instance with exhausted budget returns PENDING, never UNSAT', () => {
  const unsat = buildUnsatEngine().applyEvent({ type: 'solve' });
  assert.equal(unsat.status, 'UNSAT');
  assert.ok(unsat.unsatCore.obs.length > 0);
  const P = unsat.stats.propagation;
  assert.ok(P > 0);

  const tight = buildUnsatEngine().applyEvent({ type: 'solve', budget: { propagation: P - 1, backtrack: 1000 } });
  assert.equal(tight.status, 'PENDING');
  assert.notEqual(tight.status, 'UNSAT');
  assert.equal(tight.reason, 'BUDGET_EXCEEDED');

  const zero = buildUnsatEngine().applyEvent({ type: 'solve', budget: { propagation: 0, backtrack: 0 } });
  assert.equal(zero.status, 'PENDING');
  assert.equal(zero.exceeded, 'propagation');
  assert.ok(zero.partial.inProgress, 'keeps propagated facts even at zero budget');
});

test('partial results keep completed nights and in-progress domains', () => {
  const e = new Engine({ coordBins: 3, magBins: 1, capacity: 2 });
  e.applyEvent({ type: 'add_obs', id: 'x1', star: 'sx', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 });
  e.applyEvent({ type: 'add_obs', id: 'y1', star: 'sy', night: 1, ts: 1, coord: 1, mag: 0, conf: 1 });
  const full = new Engine({ coordBins: 3, magBins: 1, capacity: 2 });
  full.applyEvent({ type: 'add_obs', id: 'x1', star: 'sx', night: 0, ts: 1, coord: 0, mag: 0, conf: 1 });
  full.applyEvent({ type: 'add_obs', id: 'y1', star: 'sy', night: 1, ts: 1, coord: 1, mag: 0, conf: 1 });
  const fullRes = full.applyEvent({ type: 'solve' });
  const P = fullRes.stats.propagation;
  const pending = e.applyEvent({ type: 'solve', budget: { propagation: P - 1, backtrack: 10 } });
  assert.equal(pending.status, 'PENDING');
  assert.ok(pending.partial.completedNights['0'], 'first night already solved and kept');
});
