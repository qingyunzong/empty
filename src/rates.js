// Rate consistency over exact rationals.
//
// Each setRate A/B=q is the linear equality value(A) = q * value(B), i.e. the
// intersection of two half-planes; triangle consistency of the whole set is
// decided with a weighted union-find. On failure we produce a minimal
// conflict subset certificate: an exact minimum for <= 16 rate events
// (exhaustive subset search), otherwise an inclusion-minimal contradictory
// cycle extracted from the union-find forest.

import * as Q from './rational.js';

function byEvtNum(a, b) {
  const n = (s) => Number(s.split(':')[1]);
  return n(a) - n(b);
}

// Checks consistency of rate events [{eid, from, to, rate}].
// Returns { ok, find, ratioOf } on success, { ok:false, conflict } on failure
// where conflict = { eid, from, to, asserted, implied }.
export function checkRateConsistency(rateEvents) {
  const parent = new Map();
  const weight = new Map(); // weight[x] = value(x) / value(parent-chain root)

  const ensure = (x) => {
    if (!parent.has(x)) {
      parent.set(x, x);
      weight.set(x, Q.ONE);
    }
  };

  function find(x) {
    ensure(x);
    if (parent.get(x) === x) return x;
    const p = parent.get(x);
    const r = find(p);
    weight.set(x, Q.mul(weight.get(x), weight.get(p)));
    parent.set(x, r);
    return r;
  }

  const ratioOf = (x) => {
    find(x);
    return weight.get(x);
  };

  for (const e of rateEvents) {
    const { from: a, to: b, rate: q, eid } = e;
    ensure(a);
    ensure(b);
    const ra = find(a);
    const rb = find(b);
    const wa = weight.get(a);
    const wb = weight.get(b);
    if (ra === rb) {
      // Existing edges imply value(a)/value(b) = wa/wb; the new edge asserts q.
      if (!Q.eq(wa, Q.mul(q, wb))) {
        return {
          ok: false,
          conflict: { eid, from: a, to: b, asserted: q, implied: Q.div(wa, wb) },
        };
      }
    } else {
      parent.set(ra, rb);
      weight.set(ra, Q.div(Q.mul(q, wb), wa));
    }
  }
  return { ok: true, find, ratioOf };
}

function* combinations(arr, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map((i) => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === arr.length - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

// Smallest inconsistent subset of `edges` (exact for <= 16 edges, otherwise
// an inclusion-minimal contradictory cycle). Assumes edges are inconsistent.
export function minimumConflictSubset(edges) {
  if (edges.length <= 16) {
    for (let size = 1; size <= edges.length; size++) {
      for (const subset of combinations(edges, size)) {
        if (!checkRateConsistency(subset).ok) return { subset, exact: true };
      }
    }
  }
  // Inclusion-minimal fallback: the union-find conflict cycle, shrunk by a
  // deletion filter (drop any edge whose removal keeps inconsistency).
  let current = [...edges];
  for (let i = 0; i < current.length; i++) {
    const trial = current.filter((_, j) => j !== i);
    if (!checkRateConsistency(trial).ok) {
      current = trial;
      i = -1;
    }
  }
  return { subset: current, exact: false };
}

// Builds the auditable certificate for an inconsistent rate set.
export function buildCertificate(rateEvents) {
  const { subset, exact } = minimumConflictSubset(rateEvents);
  const res = checkRateConsistency(subset);
  const c = res.conflict;
  return {
    type: 'rate-conflict',
    minimality: exact ? 'exact-minimum' : 'inclusion-minimal',
    events: subset.map((e) => e.eid).sort(byEvtNum),
    cycle: subset
      .map((e) => ({ eid: e.eid, pair: e.pair, rate: Q.toString(e.rate) }))
      .sort((x, y) => byEvtNum(x.eid, y.eid)),
    detail: {
      description:
        `existing edges imply value(${c.from})/value(${c.to}) = ${Q.toString(c.implied)}, ` +
        `but ${c.eid} asserts ${Q.toString(c.asserted)}`,
      impliedRatio: Q.toString(c.implied),
      assertedRatio: Q.toString(c.asserted),
      cycleProduct: Q.toString(Q.div(c.asserted, c.implied)),
      expected: '1',
    },
  };
}
