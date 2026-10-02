import { stateHash } from './stable-json.js';

// Independent reference model used to cross-check the Ledger on small plans
// (<= 4 steps). It is deliberately a separate, purely functional
// implementation: every op maps an old state to a brand-new state, and
// rejections return the input state untouched.

function refApply(state, op) {
  const accounts = new Map(state.accounts.map((a) => [a.id, { ...a }]));
  const holds = new Map(state.holds.map((h) => [h.id, { ...h }]));
  let holdSeq = state.holdSeq;
  const out = () => ({ accounts: [...accounts.values()], holds: [...holds.values()], holdSeq });

  if (op.type === 'reserve') {
    const acc = accounts.get(op.account);
    if (!acc || acc.frozen || acc.balance - acc.held < op.amount) return out();
    acc.held += op.amount;
    const id = `H${holdSeq++}`;
    holds.set(id, { id, account: acc.id, amount: op.amount, state: 'open' });
    return out();
  }
  if (op.type === 'settle' || op.type === 'cancel') {
    const hold = holds.get(op.holdId);
    if (!hold || hold.state !== 'open') return out();
    const acc = accounts.get(hold.account);
    if (!acc || acc.frozen) return out();
    acc.held -= hold.amount;
    if (op.type === 'settle') {
      acc.balance -= hold.amount;
      hold.state = 'settled';
    } else {
      hold.state = 'cancelled';
    }
    return out();
  }
  throw new Error(`unknown op type: ${op.type}`);
}

function* permutations(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const perm of permutations(rest)) yield [items[i], ...perm];
  }
}

// Enumerates every interleaving (permutation) of the plan's ops, applies each
// to the initial state with the reference model, and returns the set of
// reachable final-state hashes plus the canonical-order hash.
export function enumerateInterleavings(initialState, ops) {
  if (ops.length > 4) throw new Error('enumerator supports plans of at most 4 steps');
  const start = {
    accounts: initialState.accounts.map((a) => ({ ...a })),
    holds: [],
    holdSeq: 0,
  };
  const reachable = new Map(); // hash -> count
  let canonicalHash = null;
  let first = true;
  for (const perm of permutations(ops)) {
    let state = start;
    for (const op of perm) state = refApply(state, op);
    const hash = stateHash({ accounts: state.accounts, holds: state.holds });
    reachable.set(hash, (reachable.get(hash) ?? 0) + 1);
    if (first) canonicalHash = hash; // permutations() yields identity order first
    first = false;
  }
  return { canonicalHash, reachable };
}
