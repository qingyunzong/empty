'use strict';

function referenceRun(accounts, txs) {
  const state = {};
  for (const [name, a] of Object.entries(accounts)) {
    state[name] = { balance: a.balance, creditLimit: a.creditLimit };
  }
  const decisions = {};
  for (const tx of txs) {
    let reason = null;
    for (const leg of tx.legs) {
      const a = state[leg.acct];
      if (leg.amount < 0 && a.balance + leg.amount < 0) reason = 'INSUFFICIENT_FUNDS';
      if (leg.amount > 0 && a.balance + leg.amount > a.creditLimit) reason = 'CREDIT_LIMIT';
    }
    if (reason) {
      decisions[tx.tx] = { decision: 'abort', reason };
      continue;
    }
    for (const leg of tx.legs) state[leg.acct].balance += leg.amount;
    decisions[tx.tx] = { decision: 'commit', reason: null };
  }
  const balances = {};
  for (const [name, a] of Object.entries(state)) balances[name] = a.balance;
  return { decisions, balances };
}

module.exports = { referenceRun };
