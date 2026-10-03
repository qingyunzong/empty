// Independent brute-force enumerator used to cross-check the main checker.
// Deliberately shares no code with src/model.js / src/checker.js: it has its
// own tiny sequential simulator and enumerates all n! permutations.
// Intended for histories of <= 6 operations.

// Sequential replay of a permutation; returns true iff every recorded
// response is reproduced.
function replay(perm, initialBalances) {
  const balance = new Map(Object.entries(initialBalances));
  const frozen = new Map();
  const reservations = new Map(); // id -> { account, amount, status }

  const bal = (a) => (balance.has(a) ? balance.get(a) : 0);
  const fro = (a) => (frozen.has(a) ? frozen.get(a) : 0);

  for (const op of perm) {
    switch (op.type) {
      case 'reserve': {
        const ok = !reservations.has(op.reserveId) && bal(op.account) >= op.amount;
        if (ok !== op.ok) return false;
        if (ok) {
          balance.set(op.account, bal(op.account) - op.amount);
          frozen.set(op.account, fro(op.account) + op.amount);
          reservations.set(op.reserveId, {
            account: op.account,
            amount: op.amount,
            status: 'open',
          });
        }
        break;
      }
      case 'commit': {
        const r = reservations.get(op.reserveId);
        const ok = Boolean(r) && r.status === 'open';
        if (ok !== op.ok) return false;
        if (ok) {
          frozen.set(r.account, fro(r.account) - r.amount);
          r.status = 'committed';
        }
        break;
      }
      case 'cancel': {
        const r = reservations.get(op.reserveId);
        const ok = Boolean(r) && r.status === 'open';
        if (ok !== op.ok) return false;
        if (ok) {
          frozen.set(r.account, fro(r.account) - r.amount);
          balance.set(r.account, bal(r.account) + r.amount);
          r.status = 'cancelled';
        }
        break;
      }
      case 'read': {
        if (op.ok !== true) return false;
        if (op.result.balance !== bal(op.account)) return false;
        if (op.result.frozen !== fro(op.account)) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

// Real-time consistency of a permutation: for every pair (earlier, later) in
// the permutation, it must NOT be the case that `later` responded before
// `earlier` was invoked (which would force later < earlier).
function respectsRealTime(perm) {
  for (let i = 0; i < perm.length; i++) {
    for (let j = i + 1; j < perm.length; j++) {
      if (perm[j].responseTime <= perm[i].invocationTime) return false;
    }
  }
  return true;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

// Returns { linearizable, witness? } where witness is the first valid
// permutation found (as opIds).
export function enumerateLinearizations(ops, options = {}) {
  const initialBalances = options.initial ?? {};
  for (const perm of permutations([...ops])) {
    if (!respectsRealTime(perm)) continue;
    if (replay(perm, initialBalances)) {
      return { linearizable: true, witness: perm.map((op) => op.opId) };
    }
  }
  return { linearizable: false };
}
