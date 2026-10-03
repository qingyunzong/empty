'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { STATES, TRANSITIONS, canTransition, isTerminal, isValidState } = require('../src/stateMachine');

const LINEAR_STATES = ['created', 'assigned', 'in_progress', 'done'];

const EXPECTED_LINEAR = {
  created: { created: false, assigned: true, in_progress: false, done: false },
  assigned: { created: false, assigned: false, in_progress: true, done: false },
  in_progress: { created: false, assigned: false, in_progress: false, done: true },
  done: { created: false, assigned: false, in_progress: false, done: false },
};

test('all 16 transitions among the 4 linear states match the reference table', () => {
  let checked = 0;
  for (const from of LINEAR_STATES) {
    for (const to of LINEAR_STATES) {
      assert.equal(
        canTransition(from, to),
        EXPECTED_LINEAR[from][to],
        from + ' -> ' + to
      );
      checked += 1;
    }
  }
  assert.equal(checked, 16);
});

test('canceled is reachable from created, assigned and in_progress only', () => {
  assert.equal(canTransition('created', 'canceled'), true);
  assert.equal(canTransition('assigned', 'canceled'), true);
  assert.equal(canTransition('in_progress', 'canceled'), true);
  assert.equal(canTransition('done', 'canceled'), false);
  assert.equal(canTransition('canceled', 'canceled'), false);
});

test('terminal states have no outgoing transitions', () => {
  for (const to of STATES) {
    assert.equal(canTransition('done', to), false, 'done -> ' + to);
    assert.equal(canTransition('canceled', to), false, 'canceled -> ' + to);
  }
  assert.equal(isTerminal('done'), true);
  assert.equal(isTerminal('canceled'), true);
  assert.equal(isTerminal('created'), false);
});

test('transition table covers every declared state', () => {
  for (const state of STATES) {
    assert.ok(Array.isArray(TRANSITIONS[state]), 'missing transitions for ' + state);
    assert.equal(isValidState(state), true);
  }
  assert.equal(isValidState('bogus'), false);
});
