'use strict';

// Independent reference state machine used to cross-check lib/model.
// Same business rules, separate implementation. Returns numeric codes:
// 0 = accept, otherwise the spec error code.

const C = {
  MALFORMED: 10,
  DANGLING: 30,
  DUP_REFUND: 31,
  NO_FREEZE: 32,
  NOT_VOIDABLE: 33,
  DUP_ID: 34,
  NO_BALANCE: 35,
  NO_REFUND_BALANCE: 36,
};

function createRef() {
  return { seq: 0, accounts: {}, sales: {}, refunds: {} };
}

function acc(st, id) {
  if (!st.accounts[id]) st.accounts[id] = { balance: 0, frozen: 0 };
  return st.accounts[id];
}

function look(st, id) {
  return st.accounts[id] || { balance: 0, frozen: 0 };
}

function posInt(n) {
  return Number.isInteger(n) && n > 0;
}

function check(st, e) {
  if (!e || typeof e.type !== 'string') return C.MALFORMED;
  if (e.type === 'sale') {
    if (typeof e.id !== 'string' || typeof e.account !== 'string' || !posInt(e.amount)) return C.MALFORMED;
    return st.sales[e.id] ? C.DUP_ID : 0;
  }
  if (e.type === 'freeze') {
    if (typeof e.account !== 'string' || !posInt(e.amount)) return C.MALFORMED;
    return look(st, e.account).balance < e.amount ? C.NO_BALANCE : 0;
  }
  if (e.type === 'unfreeze') {
    if (typeof e.account !== 'string' || !posInt(e.amount)) return C.MALFORMED;
    return look(st, e.account).frozen < e.amount ? C.NO_FREEZE : 0;
  }
  if (e.type === 'refund') {
    if (typeof e.id !== 'string' || typeof e.ref !== 'string' || !posInt(e.amount)) return C.MALFORMED;
    if (st.refunds[e.id]) return C.DUP_ID;
    const s = st.sales[e.ref];
    if (!s) return C.DANGLING;
    if (s.refunded + e.amount > s.amount) return C.DUP_REFUND;
    const a = look(st, s.account);
    if (a.frozen < e.amount) return C.NO_FREEZE;
    if (a.balance < e.amount) return C.NO_REFUND_BALANCE;
    return 0;
  }
  if (e.type === 'refundVoid') {
    if (typeof e.ref !== 'string') return C.MALFORMED;
    const r = st.refunds[e.ref];
    if (!r) return C.DANGLING;
    if (r.voided) return C.NOT_VOIDABLE;
    // must be the most recent unconsumed refund on its account
    let best = null;
    for (const k of Object.keys(st.refunds)) {
      const x = st.refunds[k];
      if (x.account === r.account && !x.voided && (!best || x.n > best.n)) best = x;
    }
    return best && best.id === e.ref ? 0 : C.NOT_VOIDABLE;
  }
  return C.MALFORMED;
}

function run(st, e) {
  st.seq += 1;
  if (e.type === 'sale') {
    const a = acc(st, e.account);
    a.balance += e.amount;
    a.frozen += e.amount;
    st.sales[e.id] = { account: e.account, amount: e.amount, refunded: 0 };
  } else if (e.type === 'freeze') {
    const a = acc(st, e.account);
    a.balance -= e.amount;
    a.frozen += e.amount;
  } else if (e.type === 'unfreeze') {
    const a = acc(st, e.account);
    a.frozen -= e.amount;
    a.balance += e.amount;
  } else if (e.type === 'refund') {
    const s = st.sales[e.ref];
    const a = acc(st, s.account);
    a.balance -= e.amount;
    a.frozen -= e.amount;
    s.refunded += e.amount;
    st.refunds[e.id] = { id: e.id, saleId: e.ref, account: s.account, amount: e.amount, voided: false, n: st.seq };
  } else if (e.type === 'refundVoid') {
    const r = st.refunds[e.ref];
    const s = st.sales[r.saleId];
    const a = acc(st, r.account);
    a.balance += r.amount;
    a.frozen += r.amount;
    s.refunded -= r.amount;
    r.voided = true;
  }
}

function accountsOf(st) {
  const out = {};
  for (const k of Object.keys(st.accounts).sort()) out[k] = { ...st.accounts[k] };
  return out;
}

module.exports = { C, createRef, check, run, accountsOf };
