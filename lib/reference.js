'use strict';

// Reference solver: enumerates every permutation of the candidate requests and
// checks every prefix for feasibility. Used to cross-validate the backtracking
// solver on small inputs (<= 5 requests).

function simulate(seq, canonical, orders, edges) {
  const state = new Map();
  for (const [id, o] of orders) {
    state.set(id, { charged: o.charged, refunded: 0, voided: false, frozenLeft: o.frozen });
  }
  const pos = new Map();
  seq.forEach((idx, i) => pos.set(idx, i));
  for (const idx of seq) {
    const c = canonical[idx];
    const st = state.get(c.orderId);
    if (c.type === 'refund') {
      if (st.voided) return false;
      if (st.refunded + c.amount > st.charged) return false;
      st.refunded += c.amount;
    } else if (c.type === 'void') {
      st.voided = true;
    } else {
      if (!st.voided) return false;
      if (c.amount > st.frozenLeft) return false;
      st.frozenLeft -= c.amount;
    }
  }
  for (const [before, after] of edges) {
    if (pos.has(after) && (!pos.has(before) || pos.get(before) >= pos.get(after))) {
      return false;
    }
  }
  return true;
}

function lexLess(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

function bruteForceCommitSequence(candidates, canonical, orders, edges) {
  let best = [];
  const used = new Array(candidates.length).fill(false);
  const current = [];

  function visit() {
    if (current.length > 0 && simulate(current, canonical, orders, edges)) {
      if (
        current.length > best.length ||
        (current.length === best.length && lexLess(current, best))
      ) {
        best = current.slice();
      }
    }
    if (current.length === candidates.length) return;
    for (let i = 0; i < candidates.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      current.push(candidates[i]);
      visit();
      current.pop();
      used[i] = false;
    }
  }

  visit();
  return best;
}

module.exports = { bruteForceCommitSequence, simulate };
