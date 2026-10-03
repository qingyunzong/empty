'use strict';

const crypto = require('crypto');

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Deterministic terminal-state certificate. Per-account hash commits to
// (account, balance, frozen); overall hash commits to all account hashes + seq.
// Recomputable offline from the event log alone.
function cert(state) {
  const names = Object.keys(state.accounts).sort();
  const accounts = {};
  for (const name of names) {
    const a = state.accounts[name];
    accounts[name] = {
      balance: a.balance,
      frozen: a.frozen,
      hash: sha256hex(`${name}|${a.balance}|${a.frozen}`),
    };
  }
  const overall = sha256hex(names.map((n) => accounts[n].hash).join('') + `|seq:${state.seq}`);
  return { seq: state.seq, accounts, overall };
}

module.exports = { cert, sha256hex };
