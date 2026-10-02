'use strict';

// Explicit transition table. Terminal states have no outgoing edges.
const TRANSITIONS = {
  auth: { capture: 'captured', void: 'voided' },
  captured: { refund: 'refunded', chargeback: 'charged_back' },
  refunded: { reverse: 'captured' },
  charged_back: { reverse_chargeback: 'captured' },
  voided: {},
};

const TERMINAL = new Set(Object.keys(TRANSITIONS).filter((s) => Object.keys(TRANSITIONS[s]).length === 0));

function nextState(state, op) {
  const edges = TRANSITIONS[state];
  if (!edges || !(op in edges)) return null;
  return edges[op];
}

module.exports = { TRANSITIONS, TERMINAL, nextState };
