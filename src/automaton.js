'use strict';

const { contentKey, chainsByAccount, isBalancedEvents } = require('./model');

// Compile a book into an automaton accepting exactly the sequences that are
// permutations of the book's events preserving per-account causal order
// (顺序允许重排但同账户因果保持). A state is the vector of consumed counts per
// account chain; the alphabet is the book's events; the accepting condition
// additionally requires the consumed (full) multiset to be locally balanced
// (同关联号借贷配对、总额按币种为零 — enforced per relation group, with
// CURRENCY_MIX already rejected at input validation).
function compileBook(events, name = 'book') {
  const accounts = [...new Set(events.map((e) => e.account))];
  const indexOf = new Map(accounts.map((a, i) => [a, i]));
  const chains = accounts.map(() => []);
  for (const e of events) chains[indexOf.get(e.account)].push(e);
  return {
    name,
    events,
    accounts,
    chains,
    initialState: () => new Array(accounts.length).fill(0),
    isFinal: (state) => state.every((v, i) => v === chains[i].length),
    nextEvent: (state, i) => (state[i] < chains[i].length ? chains[i][state[i]] : null),
    advance: (state, i) => {
      const next = state.slice();
      next[i] += 1;
      return next;
    },
    key: (state) => state.join(','),
  };
}

// Explicit lazy product automaton: states are pairs of per-book states,
// transitions synchronize on identical event content. Explored with BFS.
// Returns { status: 'accept', witness } | { status: 'reject' } |
// { status: 'unknown', statesExplored } (state cap exceeded — never reported
// as "no difference"; callers must treat it as inconclusive).
function productExplore(leftEvents, rightEvents, opts = {}) {
  const stateCap = opts.stateCap || 100000;
  const A = compileBook(leftEvents, 'left');
  const B = compileBook(rightEvents, 'right');
  const indexB = new Map(B.accounts.map((a, i) => [a, i]));
  const startKey = A.key(A.initialState()) + '|' + B.key(B.initialState());
  const seen = new Set([startKey]);
  let frontier = [{ sa: A.initialState(), sb: B.initialState(), path: [] }];
  let statesExplored = 1;
  while (frontier.length > 0) {
    const next = [];
    for (const node of frontier) {
      const finalA = A.isFinal(node.sa);
      const finalB = B.isFinal(node.sb);
      if (finalA && finalB) {
        // The consumed multiset is the whole book on both sides, so balance is
        // path-independent: either every accepting path is balanced or none is.
        if (isBalancedEvents(A.events)) {
          return { status: 'accept', witness: node.path.slice(), statesExplored };
        }
        return { status: 'reject', reason: 'unbalanced', statesExplored };
      }
      for (let i = 0; i < A.accounts.length; i += 1) {
        const ea = A.nextEvent(node.sa, i);
        if (!ea) continue;
        const j = indexB.get(A.accounts[i]);
        if (j === undefined) continue;
        const eb = B.nextEvent(node.sb, j);
        if (!eb || contentKey(ea) !== contentKey(eb)) continue;
        const sa2 = A.advance(node.sa, i);
        const sb2 = B.advance(node.sb, j);
        const key = A.key(sa2) + '|' + B.key(sb2);
        if (seen.has(key)) continue;
        seen.add(key);
        statesExplored += 1;
        if (statesExplored > stateCap) {
          return { status: 'unknown', statesExplored };
        }
        next.push({ sa: sa2, sb: sb2, path: [...node.path, ea.id] });
      }
    }
    frontier = next;
  }
  return { status: 'reject', reason: 'no-common-linearization', statesExplored };
}

// Proven emptiness criterion for the product automaton (used as the scalable
// decision procedure; the explicit BFS above is used for small books and is
// cross-checked against this in the enumeration test):
//   a common accepted sequence exists iff
//   (1) both books contain the same events (same id => same content), and
//   (2) for every account, both books list those events in the same order, and
//   (3) the (shared) multiset is locally balanced.
// Proof sketch: a common sequence contains exactly each book's events, so (1)
// holds; restricted to any account it must equal both chains, so (2) holds;
// acceptance requires balance, so (3) holds. Conversely, if (1)-(3) hold then
// the left book's own sequence is accepted by both automata and is balanced.
function jointAcceptable(L, R) {
  if (L.length !== R.length) return false;
  const byIdR = new Map(R.map((e) => [e.id, e]));
  for (const e of L) {
    const o = byIdR.get(e.id);
    if (!o || contentKey(o) !== contentKey(e)) return false;
  }
  const chainsL = chainsByAccount(L);
  const chainsR = chainsByAccount(R);
  for (const [account, ids] of chainsL) {
    const other = chainsR.get(account) || [];
    if (ids.length !== other.length) return false;
    for (let i = 0; i < ids.length; i += 1) {
      if (ids[i] !== other[i]) return false;
    }
  }
  return isBalancedEvents(L);
}

module.exports = { compileBook, productExplore, jointAcceptable };
