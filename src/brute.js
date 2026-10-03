// Independent brute-force reference checker: enumerates ALL n! permutations
// and simulates each with its own tiny interpreter. Intended for
// cross-checking the main checker on small histories (n <= ~8).

import { validateHistory } from './model.js';

function simulatePermutation(perm, history, initialBalance) {
  const balance = new Map();
  const frozen = new Map();
  const reservations = new Map();
  const bal = (a) => (balance.has(a) ? balance.get(a) : initialBalance);
  const frz = (a) => (frozen.has(a) ? frozen.get(a) : 0);

  for (const idx of perm) {
    const op = history[idx];
    if (op.type === 'reserve') {
      let ok = false;
      if (!reservations.has(op.reserveId) && op.amount <= bal(op.account)) {
        balance.set(op.account, bal(op.account) - op.amount);
        frozen.set(op.account, frz(op.account) + op.amount);
        reservations.set(op.reserveId, { account: op.account, amount: op.amount, st: 'held' });
        ok = true;
      }
      if ((op.status ?? 'ok') !== (ok ? 'ok' : 'fail')) return false;
    } else if (op.type === 'commit') {
      const r = reservations.get(op.reserveId);
      const ok = !!r && r.st === 'held';
      if ((op.status ?? 'ok') !== (ok ? 'ok' : 'fail')) return false;
      if (ok) {
        frozen.set(r.account, frz(r.account) - r.amount);
        r.st = 'committed';
      }
    } else if (op.type === 'cancel') {
      const r = reservations.get(op.reserveId);
      const ok = !!r && r.st === 'held';
      if ((op.status ?? 'ok') !== (ok ? 'ok' : 'fail')) return false;
      if (ok) {
        frozen.set(r.account, frz(r.account) - r.amount);
        balance.set(r.account, bal(r.account) + r.amount);
        r.st = 'cancelled';
      }
    } else if (op.type === 'read') {
      if (op.balance !== bal(op.account) || op.frozen !== frz(op.account)) return false;
    }
  }
  return true;
}

function respectsRealTime(perm, history) {
  const pos = new Array(perm.length);
  perm.forEach((opIndex, p) => {
    pos[opIndex] = p;
  });
  for (let i = 0; i < history.length; i++) {
    for (let j = 0; j < history.length; j++) {
      if (i !== j && history[i].responseTime <= history[j].invocationTime && pos[i] > pos[j]) {
        return false;
      }
    }
  }
  return true;
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items.slice();
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) {
      yield [items[i], ...tail];
    }
  }
}

export function bruteForceCheck(history, options = {}) {
  const initialBalance = options.initialBalance ?? 0;
  validateHistory(history);
  const n = history.length;
  const indices = Array.from({ length: n }, (_, i) => i);
  let tried = 0;
  for (const perm of permutations(indices)) {
    tried++;
    if (!respectsRealTime(perm, history)) continue;
    if (simulatePermutation(perm, history, initialBalance)) {
      return {
        linearizable: true,
        order: perm.map((i) => history[i].opId),
        permutationsTried: tried,
      };
    }
  }
  return { linearizable: false, permutationsTried: tried };
}
