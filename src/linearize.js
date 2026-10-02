import { Ledger, applyOp } from './limit.js';

function stateKey(ledger) {
  const parts = [];
  for (const [name, acct] of [...ledger.accounts].sort()) {
    parts.push(`a:${name}:${acct.creditLimit},${acct.frozen},${acct.used}`);
  }
  for (const [id, auth] of [...ledger.auths].sort()) {
    parts.push(
      `u:${id}:${auth.acc},${auth.amount},${auth.captured},${auth.expiresAt},${auth.state}`
    );
  }
  return parts.join('|');
}

export function checkLinearizable(log, { nodeBudget = 200000 } = {}) {
  const entries = log.map((entry, index) => ({
    ...entry,
    _index: index,
    _expect: entry.result ?? 'ok',
  }));

  const replay = (order) => {
    const ledger = new Ledger();
    for (const i of order) {
      if (applyOp(ledger, entries[i]) !== entries[i]._expect) return false;
    }
    return true;
  };

  const identity = entries.map((_, i) => i);
  if (replay(identity)) {
    return { linearizable: true, witness: identity.map((i) => entries[i]._index) };
  }

  const n = entries.length;
  let nodes = 0;
  let exhausted = false;
  const memo = new Set();

  const search = (ledger, remaining, prefix) => {
    if (remaining.length === 0) return prefix;
    if (++nodes > nodeBudget) {
      exhausted = true;
      return null;
    }
    const key = stateKey(ledger) + '#' + remaining.slice().sort((a, b) => a - b).join(',');
    if (memo.has(key)) return null;
    for (let k = 0; k < remaining.length; k++) {
      const i = remaining[k];
      const next = ledger.clone();
      if (applyOp(next, entries[i]) !== entries[i]._expect) continue;
      const rest = remaining.slice(0, k).concat(remaining.slice(k + 1));
      const found = search(next, rest, prefix.concat(i));
      if (found) return found;
      if (exhausted) return null;
    }
    memo.add(key);
    return null;
  };

  const order = search(new Ledger(), identity, []);
  if (order) {
    return { linearizable: true, witness: order.map((i) => entries[i]._index) };
  }
  return { linearizable: false, witness: null, ...(exhausted ? { incomplete: true } : {}) };
}
