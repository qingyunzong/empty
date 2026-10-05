import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.js';
import { EXIT } from '../src/errors.js';

const config = { tools: { T1: 50 } };

const log = [
  { id: 'm1', type: 'measure', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length: 40, deps: [] },
  { id: 'c1', type: 'cut', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length: 20, deps: ['m1'] },
  { id: 'cmp1', type: 'compensate', target: 'm1', deps: ['m1', 'c1'] },
];

test('over-life cut locks the tool, marks scrap and reports earliest overspend', () => {
  const { outcome, error } = analyze(log.slice(0, 2), config);
  assert.equal(error.code, EXIT.BUDGET);
  assert.equal(outcome.tools.T1.state, 'locked');
  assert.equal(outcome.overspendPoint, 'c1');
  assert.deepEqual(outcome.scraps, [{ event: 'c1', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1' }]);
});

test('compensating a locked fact cannot rewrite it, only generates a recovery path', () => {
  const { outcome, error } = analyze(log, config);
  assert.equal(error.code, EXIT.BUDGET);
  assert.equal(outcome.tools.T1.state, 'locked');
  assert.equal(outcome.tools.T1.used, 60);
  assert.equal(outcome.compensations.length, 0);
  assert.equal(outcome.scraps.length, 1);
  assert.equal(outcome.scraps[0].event, 'c1');
  assert.equal(outcome.recovery.length, 1);
  const [path] = outcome.recovery;
  assert.equal(path.target, 'm1');
  assert.equal(path.preservedFacts.scraps[0].event, 'c1');
  assert.ok(path.suggestions.some((s) => s.type === 'tool_change'));
});

test('no recovery sequence can unmark scrap or unlock the tool', () => {
  const extended = [
    ...log,
    { id: 'tc1', type: 'tool_change', tool: 'T1', deps: ['cmp1'] },
    { id: 'c2', type: 'cut', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1', length: 5, deps: ['tc1'] },
  ];
  const { outcome, error } = analyze(extended, config);
  assert.equal(error.code, EXIT.BUDGET);
  assert.equal(outcome.tools.T1.state, 'locked');
  assert.deepEqual(outcome.scraps, [{ event: 'c1', tool: 'T1', order: 'O1', op: 'OP1', seg: 'S1' }]);
  const transitionErrors = outcome.errors.filter((e) => e.code === EXIT.TRANSITION);
  assert.equal(transitionErrors.length, 2);
  assert.ok(transitionErrors.every((e) => e.details.from === 'locked'));
});
