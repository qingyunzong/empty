'use strict';
// Pure domain core: event application, projection, guard, certificates.
// Money is integer cents. State is plain JSON-serializable data.
//
// Semantics (invariant: 0 <= frozen <= balance per account):
//   sale       balance += amount; frozen += amount   (funds arrive frozen)
//   freeze     frozen += amount                      (needs balance - frozen >= amount)
//   unfreeze   frozen -= amount                      (needs frozen >= amount)
//   refund     balance -= amount; frozen -= amount   (atomic: unfreeze rolls back with refund)
//   refundVoid balance += amount; frozen += amount   (only the newest active refund)

const crypto = require('node:crypto');

const ERR = Object.freeze({
  DANGLING_REF: 30,        // reference to unknown sale / refund
  DUPLICATE_REFUND: 31,    // refund id reused, sale fully refunded, or concurrent over-refund conflict
  INSUFFICIENT_FROZEN: 32, // freeze/unfreeze/refund would exceed available or frozen funds
  VOID_NOT_ALLOWED: 33,    // refundVoid target is not the most recent active refund
  MALFORMED: 34,           // bad event shape
  DUPLICATE_SALE: 35,      // sale id reused
});

class GuardError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = 'GuardError';
    this.code = code;
  }
}

function initialState() {
  return { accounts: {}, sales: {}, refunds: {}, refundStack: {} };
}

function accountOf(state, account) {
  let acc = state.accounts[account];
  if (!acc) {
    acc = { balance: 0, frozen: 0 };
    state.accounts[account] = acc;
  }
  return acc;
}

function checkAmount(amount) {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new GuardError(ERR.MALFORMED, `amount must be a positive integer, got ${amount}`);
  }
}

function checkCommon(ev, fields) {
  if (!ev || typeof ev !== 'object') throw new GuardError(ERR.MALFORMED, 'event must be an object');
  for (const f of fields) {
    if (typeof ev[f] !== 'string' || ev[f].length === 0) {
      throw new GuardError(ERR.MALFORMED, `event field "${f}" must be a non-empty string`);
    }
  }
}

// Mutates `state`. Throws GuardError before any mutation when invalid,
// so a failed event (including the unfreeze leg of a refund) leaves
// the state untouched: the whole transaction rolls back.
function applyEvent(state, ev) {
  switch (ev && ev.type) {
    case 'sale': {
      checkCommon(ev, ['id', 'account']);
      checkAmount(ev.amount);
      if (state.sales[ev.id]) throw new GuardError(ERR.DUPLICATE_SALE, `sale ${ev.id} already exists`);
      const acc = accountOf(state, ev.account);
      acc.balance += ev.amount;
      acc.frozen += ev.amount;
      state.sales[ev.id] = { account: ev.account, amount: ev.amount, refunded: 0 };
      return state;
    }
    case 'freeze': {
      checkCommon(ev, ['account']);
      checkAmount(ev.amount);
      const acc = accountOf(state, ev.account);
      if (acc.balance - acc.frozen < ev.amount) {
        throw new GuardError(ERR.INSUFFICIENT_FROZEN, `freeze ${ev.amount} exceeds available ${acc.balance - acc.frozen}`);
      }
      acc.frozen += ev.amount;
      return state;
    }
    case 'unfreeze': {
      checkCommon(ev, ['account']);
      checkAmount(ev.amount);
      const acc = accountOf(state, ev.account);
      if (acc.frozen < ev.amount) {
        throw new GuardError(ERR.INSUFFICIENT_FROZEN, `unfreeze ${ev.amount} exceeds frozen ${acc.frozen}`);
      }
      acc.frozen -= ev.amount;
      return state;
    }
    case 'refund': {
      checkCommon(ev, ['id', 'saleId', 'account']);
      checkAmount(ev.amount);
      const sale = state.sales[ev.saleId];
      if (!sale) throw new GuardError(ERR.DANGLING_REF, `refund references unknown sale ${ev.saleId}`);
      if (sale.account !== ev.account) {
        throw new GuardError(ERR.DANGLING_REF, `refund account ${ev.account} does not own sale ${ev.saleId}`);
      }
      if (state.refunds[ev.id]) throw new GuardError(ERR.DUPLICATE_REFUND, `refund ${ev.id} already exists`);
      const remaining = sale.amount - sale.refunded;
      if (ev.amount > remaining) {
        throw new GuardError(ERR.DUPLICATE_REFUND, `refund ${ev.amount} exceeds unrefunded remainder ${remaining} of sale ${ev.saleId}`);
      }
      const acc = accountOf(state, sale.account);
      // Linked unfreeze, same transaction: check before mutating anything.
      if (acc.frozen < ev.amount) {
        throw new GuardError(ERR.INSUFFICIENT_FROZEN, `refund ${ev.amount} exceeds frozen ${acc.frozen}; transaction rolled back`);
      }
      acc.balance -= ev.amount;
      acc.frozen -= ev.amount;
      sale.refunded += ev.amount;
      state.refunds[ev.id] = { saleId: ev.saleId, account: sale.account, amount: ev.amount, voided: false };
      (state.refundStack[sale.account] || (state.refundStack[sale.account] = [])).push(ev.id);
      return state;
    }
    case 'refundVoid': {
      checkCommon(ev, ['refundId']);
      const rf = state.refunds[ev.refundId];
      if (!rf) throw new GuardError(ERR.DANGLING_REF, `refundVoid references unknown refund ${ev.refundId}`);
      const stack = state.refundStack[rf.account] || [];
      if (rf.voided || stack[stack.length - 1] !== ev.refundId) {
        throw new GuardError(ERR.VOID_NOT_ALLOWED, `refund ${ev.refundId} is not the most recent active refund of ${rf.account}`);
      }
      const sale = state.sales[rf.saleId];
      const acc = accountOf(state, rf.account);
      acc.balance += rf.amount;
      acc.frozen += rf.amount;
      sale.refunded -= rf.amount;
      rf.voided = true;
      stack.pop();
      return state;
    }
    default:
      throw new GuardError(ERR.MALFORMED, `unknown event type ${ev && ev.type}`);
  }
}

function project(events) {
  const state = initialState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hashState(state) {
  return sha256(canonical(state));
}

// Validate an event against a state without applying it.
// On rejection returns a deterministic certificate (state hash + code + reason)
// so conflicts can be verified offline.
function guard(state, ev) {
  const draft = structuredClone(state);
  try {
    applyEvent(draft, ev);
    return { ok: true };
  } catch (e) {
    if (!(e instanceof GuardError)) throw e;
    return {
      ok: false,
      code: e.code,
      reason: e.message,
      certificate: { code: e.code, reason: e.message, event: ev, stateHash: hashState(state) },
    };
  }
}

// Per-account terminal-state certificate, recomputable offline from the log.
function certify(state) {
  const accounts = {};
  for (const name of Object.keys(state.accounts).sort()) {
    const acc = state.accounts[name];
    accounts[name] = sha256(canonical({ account: name, balance: acc.balance, frozen: acc.frozen }));
  }
  const overall = sha256(Object.keys(accounts).map((k) => k + ':' + accounts[k]).join('\n'));
  return { accounts, overall };
}

module.exports = { ERR, GuardError, initialState, applyEvent, project, guard, certify, hashState, canonical, sha256 };
