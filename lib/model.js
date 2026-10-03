'use strict';

// Error codes (group 17 spec):
//  30 dangling reference, 31 duplicate refund, 32 insufficient freeze.
// Additional internal codes:
//  10 malformed event, 33 refund not voidable, 34 duplicate id,
//  35 insufficient balance for freeze, 36 insufficient balance for refund,
//  40 concurrency conflict.
const ERR = {
  MALFORMED: 10,
  DANGLING_REF: 30,
  DUPLICATE_REFUND: 31,
  INSUFFICIENT_FREEZE: 32,
  REFUND_NOT_VOIDABLE: 33,
  DUPLICATE_ID: 34,
  INSUFFICIENT_BALANCE: 35,
  INSUFFICIENT_REFUND_BALANCE: 36,
  CONFLICT: 40,
};

function ok() {
  return { ok: true };
}

function fail(code, message) {
  return { ok: false, code, message };
}

function createState() {
  return { seq: 0, accounts: {}, sales: {}, refunds: {} };
}

function peekAccount(state, id) {
  return state.accounts[id] || { balance: 0, frozen: 0 };
}

function ensureAccount(state, id) {
  if (!state.accounts[id]) state.accounts[id] = { balance: 0, frozen: 0 };
  return state.accounts[id];
}

function isAmount(n) {
  return Number.isInteger(n) && n > 0;
}

function latestUnconsumedRefund(state, account) {
  let latest = null;
  for (const r of Object.values(state.refunds)) {
    if (r.account !== account || r.voided) continue;
    if (!latest || r.seq > latest.seq) latest = r;
  }
  return latest;
}

// Pure validation; never mutates state.
function guard(state, event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') {
    return fail(ERR.MALFORMED, 'malformed event');
  }
  switch (event.type) {
    case 'sale': {
      if (typeof event.id !== 'string' || typeof event.account !== 'string' || !isAmount(event.amount)) {
        return fail(ERR.MALFORMED, 'sale requires string id, string account, positive integer amount');
      }
      if (state.sales[event.id]) return fail(ERR.DUPLICATE_ID, `sale ${event.id} already exists`);
      return ok();
    }
    case 'freeze': {
      if (typeof event.account !== 'string' || !isAmount(event.amount)) {
        return fail(ERR.MALFORMED, 'freeze requires string account, positive integer amount');
      }
      const acc = peekAccount(state, event.account);
      if (acc.balance < event.amount) {
        return fail(ERR.INSUFFICIENT_BALANCE, `freeze of ${event.amount} exceeds balance ${acc.balance}`);
      }
      return ok();
    }
    case 'unfreeze': {
      if (typeof event.account !== 'string' || !isAmount(event.amount)) {
        return fail(ERR.MALFORMED, 'unfreeze requires string account, positive integer amount');
      }
      const acc = peekAccount(state, event.account);
      if (acc.frozen < event.amount) {
        return fail(ERR.INSUFFICIENT_FREEZE, `unfreeze of ${event.amount} exceeds frozen ${acc.frozen}`);
      }
      return ok();
    }
    case 'refund': {
      if (typeof event.id !== 'string' || typeof event.ref !== 'string' || !isAmount(event.amount)) {
        return fail(ERR.MALFORMED, 'refund requires string id, string ref, positive integer amount');
      }
      if (state.refunds[event.id]) return fail(ERR.DUPLICATE_ID, `refund ${event.id} already exists`);
      const sale = state.sales[event.ref];
      if (!sale) return fail(ERR.DANGLING_REF, `dangling reference: sale ${event.ref} not found`);
      if (sale.refunded + event.amount > sale.amount) {
        return fail(ERR.DUPLICATE_REFUND,
          `duplicate refund: sale ${event.ref} already refunded ${sale.refunded}/${sale.amount}, requested ${event.amount}`);
      }
      const acc = peekAccount(state, sale.account);
      if (acc.frozen < event.amount) {
        return fail(ERR.INSUFFICIENT_FREEZE, `linked unfreeze of ${event.amount} exceeds frozen ${acc.frozen}`);
      }
      if (acc.balance < event.amount) {
        return fail(ERR.INSUFFICIENT_REFUND_BALANCE, `refund of ${event.amount} exceeds balance ${acc.balance}`);
      }
      return ok();
    }
    case 'refundVoid': {
      if (typeof event.ref !== 'string') {
        return fail(ERR.MALFORMED, 'refundVoid requires string ref');
      }
      const refund = state.refunds[event.ref];
      if (!refund) return fail(ERR.DANGLING_REF, `dangling reference: refund ${event.ref} not found`);
      if (refund.voided) return fail(ERR.REFUND_NOT_VOIDABLE, `refund ${event.ref} already voided`);
      const latest = latestUnconsumedRefund(state, refund.account);
      if (!latest || latest.id !== event.ref) {
        return fail(ERR.REFUND_NOT_VOIDABLE,
          `refund ${event.ref} is not the most recent unconsumed refund on account ${refund.account}`);
      }
      return ok();
    }
    default:
      return fail(ERR.MALFORMED, `unknown event type ${event.type}`);
  }
}

// Applies an event; caller must have run guard() first. Atomic by construction:
// refund and its linked unfreeze mutate the in-memory state in one step.
function applyEvent(state, event) {
  state.seq += 1;
  switch (event.type) {
    case 'sale': {
      const acc = ensureAccount(state, event.account);
      acc.balance += event.amount;
      acc.frozen += event.amount; // sale freezes its own credit amount
      state.sales[event.id] = { id: event.id, account: event.account, amount: event.amount, refunded: 0 };
      break;
    }
    case 'freeze': {
      const acc = ensureAccount(state, event.account);
      acc.balance -= event.amount;
      acc.frozen += event.amount;
      break;
    }
    case 'unfreeze': {
      const acc = ensureAccount(state, event.account);
      acc.frozen -= event.amount;
      acc.balance += event.amount;
      break;
    }
    case 'refund': {
      const sale = state.sales[event.ref];
      const acc = ensureAccount(state, sale.account);
      acc.balance -= event.amount;
      acc.frozen -= event.amount; // linked unfreeze, same transaction
      sale.refunded += event.amount;
      state.refunds[event.id] = {
        id: event.id, saleId: sale.id, account: sale.account,
        amount: event.amount, voided: false, seq: state.seq,
      };
      break;
    }
    case 'refundVoid': {
      const refund = state.refunds[event.ref];
      const sale = state.sales[refund.saleId];
      const acc = ensureAccount(state, refund.account);
      acc.balance += refund.amount;
      acc.frozen += refund.amount;
      sale.refunded -= refund.amount;
      refund.voided = true;
      break;
    }
    default:
      throw new Error(`cannot apply unguarded event type ${event.type}`);
  }
}

// Folds an event log into a state. Throws if the log contains an invalid event.
function project(events) {
  const state = createState();
  events.forEach((event, i) => {
    const g = guard(state, event);
    if (!g.ok) throw new Error(`invalid event at log index ${i}: [${g.code}] ${g.message}`);
    applyEvent(state, event);
  });
  return state;
}

// Public projection view: per-account balance and frozen amounts.
function projectionOf(state) {
  const accounts = {};
  for (const name of Object.keys(state.accounts).sort()) {
    accounts[name] = { balance: state.accounts[name].balance, frozen: state.accounts[name].frozen };
  }
  return { seq: state.seq, accounts };
}

module.exports = {
  ERR, guard, applyEvent, project, projectionOf, createState,
  peekAccount, ensureAccount, latestUnconsumedRefund,
};
