'use strict';

class BusinessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BusinessError';
  }
}

function emptyState() {
  return { balances: {}, fees: {}, txs: {}, cancelled: [] };
}

function balanceOf(state, account) {
  return state.balances[account] || 0;
}

function checkAmount(ev) {
  if (!Number.isInteger(ev.amount) || ev.amount <= 0) {
    throw new BusinessError(`event ${ev.tx}: amount must be a positive integer`);
  }
}

function checkCommon(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
    throw new BusinessError('event must be an object');
  }
  if (typeof ev.account !== 'string' || ev.account.length === 0) {
    throw new BusinessError('event.account must be a non-empty string');
  }
  if (typeof ev.tx !== 'string' || ev.tx.length === 0) {
    throw new BusinessError('event.tx must be a non-empty string');
  }
}

// Apply one event to the running state, enforcing business rules:
// - tx ids are unique
// - refund may not drive the account net balance negative
// - cancel must link to an existing, not-yet-cancelled original event
function applyEvent(state, ev) {
  checkCommon(ev);
  if (state.txs[ev.tx]) {
    throw new BusinessError(`duplicate tx ${ev.tx}`);
  }
  switch (ev.type) {
    case 'deposit':
      checkAmount(ev);
      state.balances[ev.account] = balanceOf(state, ev.account) + ev.amount;
      state.txs[ev.tx] = { type: ev.type, account: ev.account, amount: ev.amount };
      return;
    case 'refund': {
      checkAmount(ev);
      const next = balanceOf(state, ev.account) - ev.amount;
      if (next < 0) {
        throw new BusinessError(
          `refund ${ev.tx} would drive account ${ev.account} net balance negative`
        );
      }
      state.balances[ev.account] = next;
      state.txs[ev.tx] = { type: ev.type, account: ev.account, amount: ev.amount };
      return;
    }
    case 'fee':
      checkAmount(ev);
      state.balances[ev.account] = balanceOf(state, ev.account) - ev.amount;
      state.fees[ev.account] = (state.fees[ev.account] || 0) + ev.amount;
      state.txs[ev.tx] = { type: ev.type, account: ev.account, amount: ev.amount };
      return;
    case 'cancel': {
      const orig = state.txs[ev.refTx];
      if (!orig) {
        throw new BusinessError(`cancel ${ev.tx} references unknown tx ${ev.refTx}`);
      }
      if (orig.type === 'cancel') {
        throw new BusinessError(`cancel ${ev.tx} cannot reference a cancel event`);
      }
      if (state.cancelled.includes(ev.refTx)) {
        throw new BusinessError(`tx ${ev.refTx} already cancelled`);
      }
      if (ev.account !== orig.account) {
        throw new BusinessError(`cancel ${ev.tx} account mismatch with ${ev.refTx}`);
      }
      if (orig.type === 'deposit') {
        state.balances[orig.account] = balanceOf(state, orig.account) - orig.amount;
      } else if (orig.type === 'refund') {
        state.balances[orig.account] = balanceOf(state, orig.account) + orig.amount;
      } else if (orig.type === 'fee') {
        state.balances[orig.account] = balanceOf(state, orig.account) + orig.amount;
        state.fees[orig.account] = (state.fees[orig.account] || 0) - orig.amount;
      }
      state.cancelled.push(ev.refTx);
      state.txs[ev.tx] = {
        type: 'cancel',
        account: ev.account,
        amount: orig.amount,
        refTx: ev.refTx,
      };
      return;
    }
    default:
      throw new BusinessError(`unknown event type ${ev.type}`);
  }
}

function computeState(confirmedChunks) {
  const state = emptyState();
  for (const chunk of confirmedChunks) {
    for (const ev of chunk.events) applyEvent(state, ev);
  }
  return state;
}

function buildIndex(confirmedChunks) {
  const accounts = {};
  const txs = {};
  const refs = {};
  for (const chunk of confirmedChunks) {
    for (const ev of chunk.events) {
      if (!accounts[ev.account]) accounts[ev.account] = [];
      if (!accounts[ev.account].includes(chunk.index)) accounts[ev.account].push(chunk.index);
      txs[ev.tx] = chunk.index;
      if (ev.refTx) refs[ev.refTx] = chunk.index;
    }
  }
  return { accounts, txs, refs };
}

function sortedObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

function publicState(state) {
  return {
    balances: sortedObject(state.balances),
    fees: sortedObject(state.fees),
    cancelled: [...state.cancelled].sort(),
  };
}

module.exports = {
  BusinessError,
  emptyState,
  applyEvent,
  computeState,
  buildIndex,
  publicState,
};
