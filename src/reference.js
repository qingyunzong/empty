// Reference implementation: for <= 6 revisions, enumerate every causal
// permutation and check that the final head set and winning version agree.

export function applyRevision(rev, get) {
  if (rev.op === 'put') {
    return { price: rev.changes.price, quantity: rev.changes.quantity, status: 'active' };
  }
  const base = rev.op === 'resolve' ? get(rev.winner) : get(rev.parents[0]);
  return { ...base, ...rev.changes };
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr.slice();
    return;
  }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}

export function referenceCheck(revs) {
  const childOf = new Set();
  for (const r of revs) for (const p of r.parents) childOf.add(p);
  const heads = revs
    .filter((r) => !childOf.has(r.hash))
    .map((r) => r.hash)
    .sort();
  if (revs.length > 6) return { checked: false, reason: 'more_than_6_revisions', heads };

  const outcomes = new Set();
  let orders = 0;
  for (const perm of permutations(revs)) {
    const state = new Map();
    let valid = true;
    for (const r of perm) {
      const deps = r.op === 'resolve' ? [r.winner, ...r.parents] : r.parents;
      if (deps.some((d) => !state.has(d))) {
        valid = false;
        break;
      }
      state.set(r.hash, applyRevision(r, (h) => state.get(h)));
    }
    if (!valid) continue;
    orders++;
    outcomes.add(heads.map((h) => JSON.stringify(state.get(h))).join('|'));
  }
  const deterministic = outcomes.size === 1;
  const first = deterministic ? [...outcomes][0].split('|').map((s) => JSON.parse(s)) : null;
  return { checked: true, causalOrders: orders, heads, deterministic, winning: first };
}
