'use strict';

// Explicit DFA for the per-account transaction lifecycle.
// Any (state, op) pair not listed here is an illegal transition and drives
// the account into ERROR, from which only `repair` is accepted.
const STATES = Object.freeze(['INIT', 'OPEN', 'COMMITTED', 'VOIDED', 'ERROR']);

const TRANSITIONS = Object.freeze({
  INIT: { open: 'OPEN' },
  OPEN: {
    debit: 'OPEN',
    credit: 'OPEN',
    hold: 'OPEN',
    release: 'OPEN',
    commit: 'COMMITTED',
    void: 'VOIDED',
    undo: 'OPEN',
  },
  COMMITTED: { undo: 'OPEN' },
  VOIDED: { undo: 'OPEN' },
  ERROR: { repair: 'OPEN' },
});

function nextState(state, op) {
  const row = TRANSITIONS[state];
  if (!row) return null;
  return Object.prototype.hasOwnProperty.call(row, op) ? row[op] : null;
}

module.exports = { STATES, TRANSITIONS, nextState };
