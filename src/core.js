'use strict';

// Explicit lifecycle DFA. ERROR accepts only `repair` (handled in transition).
const DFA = Object.freeze({
  INIT: Object.freeze({ open: 'ACTIVE' }),
  ACTIVE: Object.freeze({
    debit: 'ACTIVE',
    credit: 'ACTIVE',
    hold: 'ACTIVE',
    release: 'ACTIVE',
    commit: 'COMMITTED',
    void: 'VOID',
  }),
  COMMITTED: Object.freeze({}),
  VOID: Object.freeze({}),
  ERROR: Object.freeze({ repair: 'ACTIVE' }),
});

const ERR = Object.freeze({
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',
  NEGATIVE: 'NEGATIVE',
  HOLD_LEAK: 'HOLD_LEAK',
  FORK_CONFLICT: 'FORK_CONFLICT',
  CORRUPT_JOURNAL: 'CORRUPT_JOURNAL',
});

function initialAccount() {
  return { status: 'INIT', prevStatus: null, balance: 0, frozen: 0 };
}

// Pure transition over the four lifecycle fields. Never mutates `acc`.
// Returns { state, code } where code is null on success.
function transition(acc, type, amount) {
  if (acc.status === 'ERROR') {
    if (type === 'repair') {
      return {
        state: { ...acc, status: acc.prevStatus == null ? 'INIT' : acc.prevStatus, prevStatus: null },
        code: null,
      };
    }
    return { state: acc, code: ERR.ILLEGAL_TRANSITION };
  }

  const next = Object.prototype.hasOwnProperty.call(DFA, acc.status)
    ? DFA[acc.status][type]
    : undefined;

  const fail = (code) => ({
    state: { ...acc, status: 'ERROR', prevStatus: acc.status },
    code,
  });

  if (next === undefined) return fail(ERR.ILLEGAL_TRANSITION);

  const badAmount = !Number.isFinite(amount) || amount < 0;

  switch (type) {
    case 'open':
      if (badAmount) return fail(ERR.NEGATIVE);
      return { state: { ...acc, status: next, balance: amount, frozen: 0 }, code: null };
    case 'debit':
      if (badAmount || amount > acc.balance) return fail(ERR.NEGATIVE);
      return { state: { ...acc, status: next, balance: acc.balance - amount }, code: null };
    case 'credit':
      if (badAmount) return fail(ERR.NEGATIVE);
      return { state: { ...acc, status: next, balance: acc.balance + amount }, code: null };
    case 'hold':
      if (badAmount || amount > acc.balance - acc.frozen) return fail(ERR.NEGATIVE);
      return { state: { ...acc, status: next, frozen: acc.frozen + amount }, code: null };
    case 'release':
      if (badAmount || amount > acc.frozen) return fail(ERR.HOLD_LEAK);
      return { state: { ...acc, status: next, frozen: acc.frozen - amount }, code: null };
    case 'commit':
      if (acc.frozen > 0) return fail(ERR.HOLD_LEAK);
      return { state: { ...acc, status: next }, code: null };
    case 'void':
      if (acc.frozen > 0) return fail(ERR.HOLD_LEAK);
      return { state: { ...acc, status: next }, code: null };
    default:
      return fail(ERR.ILLEGAL_TRANSITION);
  }
}

module.exports = { DFA, ERR, initialAccount, transition };
