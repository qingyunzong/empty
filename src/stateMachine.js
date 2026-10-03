'use strict';

const STATES = Object.freeze(['created', 'assigned', 'in_progress', 'done', 'canceled']);

const TERMINAL_STATES = Object.freeze(['done', 'canceled']);

const TRANSITIONS = Object.freeze({
  created: Object.freeze(['assigned', 'canceled']),
  assigned: Object.freeze(['in_progress', 'canceled']),
  in_progress: Object.freeze(['done', 'canceled']),
  done: Object.freeze([]),
  canceled: Object.freeze([]),
});

function isValidState(state) {
  return STATES.includes(state);
}

function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

function canTransition(from, to) {
  if (!isValidState(from) || !isValidState(to)) return false;
  return TRANSITIONS[from].includes(to);
}

module.exports = { STATES, TERMINAL_STATES, TRANSITIONS, isValidState, isTerminal, canTransition };
