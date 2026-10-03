'use strict';

const { BusinessError } = require('./errors');

// Which tx ops each layer kind accepts. `credit` (funds/budget injection) is
// only allowed inside reserve layers so the ledger stays recoverable from the
// data file alone.
const KIND_OPS = Object.freeze({
  reserve: new Set(['reserve', 'credit']),
  freeze: new Set(['freeze']),
  pay: new Set(['pay']),
  revert: new Set(['revert']),
});

function initialState() {
  return {
    seq: 0,
    lastCheckpointSeq: 0,
    accounts: {},
    freezes: {},
    pays: {},
  };
}

function accountOf(state, id) {
  if (!state.accounts[id]) {
    state.accounts[id] = { balance: 0, available: 0, reserved: 0, frozen: 0 };
  }
  return state.accounts[id];
}

function checkAmount(tx) {
  if (!Number.isSafeInteger(tx.amount) || tx.amount <= 0) {
    throw new BusinessError(`tx ${tx.id}: amount must be a positive integer`);
  }
}

function applyTx(state, tx, seq) {
  switch (tx.op) {
    case 'credit': {
      checkAmount(tx);
      const acc = accountOf(state, tx.account);
      acc.balance += tx.amount;
      acc.available += tx.amount;
      break;
    }
    case 'reserve': {
      checkAmount(tx);
      const acc = accountOf(state, tx.account);
      acc.reserved += tx.amount;
      break;
    }
    case 'freeze': {
      checkAmount(tx);
      if (state.freezes[tx.id]) throw new BusinessError(`duplicate freeze id ${tx.id}`);
      const acc = accountOf(state, tx.account);
      if (acc.available < tx.amount) {
        throw new BusinessError(`tx ${tx.id}: insufficient available for ${tx.account}`);
      }
      acc.available -= tx.amount;
      acc.frozen += tx.amount;
      state.freezes[tx.id] = { account: tx.account, amount: tx.amount, seq, paidBy: null };
      break;
    }
    case 'pay': {
      checkAmount(tx);
      if (state.pays[tx.id]) throw new BusinessError(`duplicate pay id ${tx.id}`);
      const freeze = state.freezes[tx.ref];
      if (!freeze) throw new BusinessError(`tx ${tx.id}: unknown freeze link ${tx.ref}`);
      if (freeze.paidBy) throw new BusinessError(`tx ${tx.id}: freeze ${tx.ref} already consumed`);
      if (freeze.account !== tx.account || freeze.amount !== tx.amount) {
        throw new BusinessError(`tx ${tx.id}: does not match freeze ${tx.ref}`);
      }
      const acc = accountOf(state, tx.account);
      if (acc.frozen < tx.amount) {
        throw new BusinessError(`tx ${tx.id}: insufficient frozen for ${tx.account}`);
      }
      if (acc.balance < tx.amount) {
        throw new BusinessError(`tx ${tx.id}: insufficient balance for ${tx.account}`);
      }
      acc.frozen -= tx.amount;
      acc.balance -= tx.amount;
      freeze.paidBy = tx.id;
      state.pays[tx.id] = { account: tx.account, amount: tx.amount, seq, ref: tx.ref, reverted: false };
      break;
    }
    case 'revert': {
      const pay = state.pays[tx.ref];
      if (!pay) throw new BusinessError(`tx ${tx.id}: unknown pay ${tx.ref}`);
      if (pay.reverted) throw new BusinessError(`tx ${tx.id}: pay ${tx.ref} already reverted`);
      if (pay.seq <= state.lastCheckpointSeq) {
        throw new BusinessError(
          `tx ${tx.id}: pay ${tx.ref} is at layer ${pay.seq}, at or before checkpoint ${state.lastCheckpointSeq}`,
        );
      }
      const freeze = state.freezes[pay.ref];
      if (!freeze) {
        throw new BusinessError(`tx ${tx.id}: freeze link ${pay.ref} of pay ${tx.ref} is missing`);
      }
      // Restore the freeze chain first, then refund the balance.
      const acc = accountOf(state, pay.account);
      acc.frozen += pay.amount;
      acc.balance += pay.amount;
      freeze.paidBy = null;
      pay.reverted = true;
      break;
    }
    default:
      throw new BusinessError(`tx ${tx.id}: unknown op ${tx.op}`);
  }
}

// Applies a whole layer atomically: the state is mutated only if every tx in
// the layer validates. Returns the (possibly new) state object.
function applyLayer(state, kind, txs, seq) {
  const allowed = KIND_OPS[kind];
  if (!allowed) throw new BusinessError(`unknown layer kind ${kind}`);
  const next = structuredClone(state);
  next.seq = seq;
  txs.forEach((tx, i) => {
    if (!allowed.has(tx.op)) {
      throw new BusinessError(`tx ${tx.id ?? i}: op ${tx.op} not allowed in ${kind} layer`);
    }
    applyTx(next, tx, seq);
  });
  return next;
}

module.exports = { KIND_OPS, initialState, applyLayer, applyTx };
