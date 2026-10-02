import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/index.js';
import { T0, MIN, temp, ship, repair, retract } from '../testlib/helpers.js';

// Acceptance 1: retracting a repair invalidates its ok=true trust boundary,
// so previously dismissed readings count again and the recall set grows.
function scenario({ withRetract }) {
  const events = [
    temp('t1', T0, 'A', -10),
    temp('t2', T0 + MIN, 'A', -9),
    temp('t3', T0 + 2 * MIN, 'A', -20),
    ship('s1', T0 + 2 * MIN + 1000, 'L1', 'A', T0 - 10_000, T0 + 3 * MIN),
    repair('r1', T0 + 3 * MIN, 'A', true),
  ];
  if (withRetract) events.push(retract(T0 + 4 * MIN, 'repair', 'r1'));
  return events;
}

test('repair ok=true dismisses pre-repair readings: empty recall', () => {
  const result = analyze(scenario({ withRetract: false }));
  assert.equal(result.recall.minimalSize, 0);
  assert.deepEqual(result.recall.solutions, [[]]);
  assert.equal(result.counts.dismissedReadings, 3);
});

test('retracting the repair expands the recall set', () => {
  const before = analyze(scenario({ withRetract: false }));
  const after = analyze(scenario({ withRetract: true }));
  assert.equal(before.recall.minimalSize, 0);
  assert.equal(after.recall.minimalSize, 1);
  assert.deepEqual(after.recall.solutions, [['L1']]);
  assert.equal(after.counts.dismissedReadings, 0);
  assert.equal(after.counts.unexplainedWindows, 1);
  assert.equal(after.evidence.length, 1);
  assert.equal(after.evidence[0].lot, 'L1');
});

test('repair ok=false does not establish a trust boundary', () => {
  const events = [
    temp('t1', T0, 'A', -10),
    temp('t2', T0 + MIN, 'A', -20),
    ship('s1', T0 + 2 * MIN, 'L1', 'A', T0 - 10_000, T0 + 3 * MIN),
    repair('r1', T0 + 3 * MIN, 'A', false),
  ];
  const result = analyze(events);
  assert.equal(result.counts.dismissedReadings, 0);
  assert.deepEqual(result.recall.solutions, [['L1']]);
});
