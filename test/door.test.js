import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/index.js';
import { T0, MIN, temp, door, ship } from '../testlib/helpers.js';

// Acceptance 2: a door-open joined to a short over-limit window explains it,
// avoiding a false recall.
function scenario({ withDoor }) {
  const events = [
    temp('t1', T0, 'B', -8),
    temp('t2', T0 + 5 * MIN, 'B', -20),
    ship('s1', T0 + 5 * MIN + 1000, 'L1', 'B', T0 - MIN, T0 + 10 * MIN),
  ];
  if (withDoor) events.splice(1, 0, door('d1', T0 + MIN, 'B', true));
  return events;
}

test('unexplained over-limit window triggers recall', () => {
  const result = analyze(scenario({ withDoor: false }));
  assert.equal(result.counts.unexplainedWindows, 1);
  assert.deepEqual(result.recall.solutions, [['L1']]);
});

test('door open explains short warming and avoids recall', () => {
  const result = analyze(scenario({ withDoor: true }));
  assert.equal(result.counts.windows, 1);
  assert.equal(result.counts.explainedWindows, 1);
  assert.equal(result.counts.unexplainedWindows, 0);
  assert.equal(result.recall.minimalSize, 0);
  assert.deepEqual(result.recall.solutions, [[]]);
  assert.equal(result.evidence.length, 0);
});

test('door close event does not explain the window', () => {
  const events = scenario({ withDoor: false });
  events.splice(1, 0, door('d1', T0 + MIN, 'B', false));
  const result = analyze(events);
  assert.deepEqual(result.recall.solutions, [['L1']]);
});

test('long window is not explainable by a door open', () => {
  const events = [
    temp('t1', T0, 'B', -8),
    door('d1', T0 + MIN, 'B', true),
    temp('t2', T0 + 10 * MIN, 'B', -9),
    temp('t3', T0 + 30 * MIN, 'B', -20),
    ship('s1', T0 + 31 * MIN, 'L1', 'B', T0 - MIN, T0 + 40 * MIN),
  ];
  const result = analyze(events);
  assert.equal(result.counts.explainedWindows, 0);
  assert.deepEqual(result.recall.solutions, [['L1']]);
});
