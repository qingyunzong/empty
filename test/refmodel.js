'use strict';
// Independent reference state machine used to cross-check src/model.js.
// Deliberately naive: no cached per-sale counters; every refund recomputes
// the refunded total by rescanning the event history, and refundVoid
// validity is derived by replaying voids against the refund list.

function fail(code, reason) {
  const e = new Error(reason);
  e.code = code;
  throw e;
}

// Returns { accounts: {name: {balance, frozen}} } plus throws {code} on the
// first invalid event. Mirrors the library's error codes 30/31/32/33/34/35.
function refProject(events) {
  const accounts = new Map();
  const acc = (name) => {
    if (!accounts.has(name)) accounts.set(name, { balance: 0, frozen: 0 });
    return accounts.get(name);
  };
  const sales = new Map();
  const refunds = new Map();
  const voided = new Set();

  events.forEach((ev, i) => {
    const hist = events.slice(0, i);
    switch (ev.type) {
      case 'sale': {
        if (sales.has(ev.id)) fail(35, 'dup sale');
        const a = acc(ev.account);
        a.balance += ev.amount;
        a.frozen += ev.amount;
        sales.set(ev.id, { account: ev.account, amount: ev.amount });
        break;
      }
      case 'freeze': {
        const a = acc(ev.account);
        if (a.balance - a.frozen < ev.amount) fail(32, 'freeze exceeds available');
        a.frozen += ev.amount;
        break;
      }
      case 'unfreeze': {
        const a = acc(ev.account);
        if (a.frozen < ev.amount) fail(32, 'unfreeze exceeds frozen');
        a.frozen -= ev.amount;
        break;
      }
      case 'refund': {
        const sale = sales.get(ev.saleId);
        if (!sale || sale.account !== ev.account) fail(30, 'dangling sale ref');
        if (refunds.has(ev.id)) fail(31, 'dup refund id');
        let refundedSoFar = 0;
        for (const h of hist) {
          if (h.type === 'refund' && h.saleId === ev.saleId && refunds.has(h.id) && !voided.has(h.id)) {
            refundedSoFar += h.amount;
          }
        }
        if (ev.amount > sale.amount - refundedSoFar) fail(31, 'over-refund');
        const a = acc(sale.account);
        if (a.frozen < ev.amount) fail(32, 'refund exceeds frozen');
        a.balance -= ev.amount;
        a.frozen -= ev.amount;
        refunds.set(ev.id, { saleId: ev.saleId, account: sale.account, amount: ev.amount });
        break;
      }
      case 'refundVoid': {
        const rf = refunds.get(ev.refundId);
        if (!rf) fail(30, 'dangling refund ref');
        let top = null;
        for (const h of hist) {
          if (h.type === 'refund' && refunds.has(h.id) && h.account === rf.account && !voided.has(h.id)) top = h.id;
        }
        if (voided.has(ev.refundId) || top !== ev.refundId) fail(33, 'not newest active refund');
        const a = acc(rf.account);
        a.balance += rf.amount;
        a.frozen += rf.amount;
        voided.add(ev.refundId);
        break;
      }
      default:
        fail(34, 'unknown type');
    }
  });

  const out = {};
  for (const [name, a] of [...accounts.entries()].sort()) out[name] = a;
  return { accounts: out };
}

module.exports = { refProject };
