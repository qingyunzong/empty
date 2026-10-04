// Acceptance 1: a correction propagates incrementally, triggers a chained
// reassignment, and the solve output carries a conflict explanation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { nightStarKey } from '../src/model.js';

const CONFIG = { type: 'config', coordBins: 6, magBins: 1, capacity: 4 };

function buildEngine() {
  const e = new Engine();
  e.applyEvent(CONFIG);
  e.applyEvent({ type: 'add_obs', id: 'a1', star: 'A', night: 1, ts: 1, coord: 1, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'b1', star: 'B', night: 1, ts: 1, coord: 2, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'b2', star: 'B', night: 1, ts: 2, coord: 3, mag: 0, conf: 0.8 });
  e.applyEvent({ type: 'add_obs', id: 'c1', star: 'C', night: 1, ts: 1, coord: 3, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'c2', star: 'C', night: 1, ts: 2, coord: 4, mag: 0, conf: 0.8 });
  e.applyEvent({ type: 'add_obs', id: 'd1', star: 'D', night: 1, ts: 1, coord: 4, mag: 0, conf: 0.9 });
  e.applyEvent({ type: 'add_obs', id: 'd2', star: 'D', night: 1, ts: 2, coord: 5, mag: 0, conf: 0.8 });
  return e;
}

test('correction triggers chained reassignment with conflict explanation', () => {
  const e = buildEngine();
  const first = e.applyEvent({ type: 'solve' });
  assert.equal(first.status, 'SAT');
  assert.deepEqual(first.cells['1'], { A: 1, B: 2, C: 3, D: 4 });
  assert.ok(first.stats.backtrack > 0, 'initial solve needs backtracking');

  // Incremental propagation: the correction touches only star A's domain.
  const before = structuredClone(e.state.domains);
  const corrIndex = e.events.length;
  e.applyEvent({ type: 'correct_obs', id: 'a1', coord: 2 });
  for (const key of Object.keys(e.state.domains)) {
    if (!key.endsWith('\u0001A')) {
      assert.deepEqual(e.state.domains[key], before[key], `domain of ${key} must be untouched`);
    }
  }
  assert.deepEqual(Object.keys(e.state.domains[nightStarKey(1, 'A')]).map(Number), [2]);

  const second = e.applyEvent({ type: 'solve' });
  assert.equal(second.status, 'SAT');
  assert.deepEqual(second.cells['1'], { A: 2, B: 3, C: 4, D: 5 });
  assert.equal(second.stats.backtrack, 0, 'chain resolved by propagation alone');

  // The trigger of the whole chain is the correction event.
  assert.deepEqual(second.trigger, [corrIndex]);

  // Chained reassignment: A is moved by the correction itself, then B, C
  // and D are each evicted by the previous star in the chain.
  assert.deepEqual(
    second.reassignments.map((r) => [r.star, r.from, r.to]),
    [['A', 1, 2], ['B', 2, 3], ['C', 3, 4], ['D', 4, 5]],
  );
  assert.ok(second.reassignments.every((r) => r.cause.trigger.includes(corrIndex)));

  // Conflict explanation: prune chain naming the constraint and the events.
  const prunes = second.explanation.filter((x) => x.kind === 'prune');
  assert.deepEqual(prunes.map((p) => [p.star, p.cell]), [['B', 2], ['C', 3], ['D', 4]]);
  assert.ok(prunes.every((p) => p.constraint === 'exclusive_cell'));
  const assignA = second.explanation.find((x) => x.kind === 'assign' && x.star === 'A');
  assert.ok(assignA.events.includes(corrIndex), 'explanation traces back to the correcting event');
});
