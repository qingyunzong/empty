// Comparison of two event logs as partial orders.
//
// Rules (deterministic):
//   EQUAL       - identical event universes, no dangling causes, and identical
//                 reachability (same partial order). Direct-edge redundancy and
//                 record order are irrelevant; cycles are compressed to SCCs.
//   UNDECIDED   - no contradiction, but information is missing: an event exists
//                 in only one log, a causal link is implied by only one log
//                 (one side's reachability is a strict subset), or a cause
//                 references an event absent from that log (dangling cause).
//   NOT_EQUAL   - a genuine conflict: each log's reachability contains a pair
//                 the other denies. Reports first_divergent (smallest event id
//                 whose ancestor set differs) and minimal_frontier (the
//                 transitive-reduction edges inside its past cone that differ -
//                 a minimal inconsistent predecessor set).
//
// Precedence: NOT_EQUAL > UNDECIDED > EQUAL.
//
// Reachability inclusion on shared events is decided exactly:
//   - When both logs have the same event universe, R_A subset-of R_B iff the
//     SCC partitions agree and every transitive-reduction edge of A is
//     reachable in B (linear in the graph size; proof: any reachability
//     witness decomposes into reduction edges plus intra-SCC steps).
//   - When universes differ, reachability may flow through events missing
//     from the other log, so an exact pairwise scan over shared events is
//     used instead (early exit once both directions are known to differ).

import {
  buildGraph,
  scc,
  condensation,
  reachability,
  transitiveReduction,
  bitTest,
} from './graph.js';

function analyze(events, sharedSet) {
  const g = buildGraph(events);
  const { comp, comps, compCount } = scc(g.n, g.succ);
  const { cSuccArr, topo, topoRank } = condensation(g.n, g.preds, comp, compCount);
  const reach = reachability(compCount, cSuccArr, topo);
  const red = transitiveReduction(compCount, cSuccArr, reach, topoRank);

  // Per comp: smallest shared member (if any).
  const minShared = new Array(compCount).fill(null);
  for (let i = 0; i < g.n; i++) {
    const id = g.ids[i];
    if (!sharedSet.has(id)) continue;
    const c = comp[i];
    if (minShared[c] === null || id < minShared[c]) minShared[c] = id;
  }

  // Canonical display pair per reduction comp-edge, preferring pairs whose
  // endpoints are both shared with the other log.
  const best = new Map(); // key cu:cv -> {pair, sharedBoth}
  for (let v = 0; v < g.n; v++) {
    for (const u of g.preds[v]) {
      const cu = comp[u];
      const cv = comp[v];
      if (cu === cv) continue;
      const key = cu + ':' + cv;
      const pair = [g.ids[u], g.ids[v]];
      const both = sharedSet.has(pair[0]) && sharedSet.has(pair[1]);
      const cur = best.get(key);
      if (
        !cur ||
        (both && !cur.sharedBoth) ||
        (both === cur.sharedBoth &&
          (pair[0] < cur.pair[0] || (pair[0] === cur.pair[0] && pair[1] < cur.pair[1])))
      ) {
        best.set(key, { pair, sharedBoth: both });
      }
    }
  }

  const redEdges = [];
  for (let c = 0; c < compCount; c++) {
    for (const d of red[c]) {
      const disp = best.get(c + ':' + d).pair;
      redEdges.push({
        from: disp[0],
        to: disp[1],
        fromComp: c,
        toComp: d,
        checkFrom: minShared[c],
        checkTo: minShared[d],
      });
    }
  }
  redEdges.sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0,
  );

  return { g, comp, comps, compCount, reach, redEdges };
}

export function compareLogs(eventsA, eventsB) {
  const idsA = buildGraph(eventsA).ids; // cheap pre-pass for the shared set
  const idsB = buildGraph(eventsB).ids;
  const setA = new Set(idsA);
  const setB = new Set(idsB);
  const shared = idsA.filter((id) => setB.has(id));
  const sharedSet = new Set(shared);
  const onlyA = idsA.filter((id) => !setB.has(id));
  const onlyB = idsB.filter((id) => !setA.has(id));

  const A = analyze(eventsA, sharedSet);
  const B = analyze(eventsB, sharedSet);

  const compOfA = new Map(A.g.ids.map((id, i) => [id, A.comp[i]]));
  const compOfB = new Map(B.g.ids.map((id, i) => [id, B.comp[i]]));

  let aBeyondB = false; // A implies a causal pair (on shared events) that B denies
  let bBeyondA = false;
  let firstDivergentScan = null; // smallest shared id whose ancestor set differs

  const sameUniverse = onlyA.length === 0 && onlyB.length === 0;

  // (1) SCC partitions must agree on shared events.
  {
    const seenAtoB = new Map();
    const seenBtoA = new Map();
    for (const id of shared) {
      const ca = compOfA.get(id);
      const cb = compOfB.get(id);
      if (seenAtoB.has(ca) && seenAtoB.get(ca) !== cb) aBeyondB = true;
      if (seenBtoA.has(cb) && seenBtoA.get(cb) !== ca) bBeyondA = true;
      seenAtoB.set(ca, cb);
      seenBtoA.set(cb, ca);
    }
  }

  // (2) Reduction edges of one log must be reachable in the other.
  const diffRedEdges = []; // {from, to, only_in}
  for (const e of A.redEdges) {
    if (e.checkFrom === null || e.checkTo === null) continue;
    if (bitTest(B.reach[compOfB.get(e.checkFrom)], compOfB.get(e.checkTo)) !== 1) {
      aBeyondB = true;
      diffRedEdges.push({ from: e.from, to: e.to, only_in: 'a' });
    }
  }
  for (const e of B.redEdges) {
    if (e.checkFrom === null || e.checkTo === null) continue;
    if (bitTest(A.reach[compOfA.get(e.checkFrom)], compOfA.get(e.checkTo)) !== 1) {
      bBeyondA = true;
      diffRedEdges.push({ from: e.from, to: e.to, only_in: 'b' });
    }
  }

  if (!sameUniverse) {
    // Universes differ: reachability may flow through events the other log
    // never recorded. The reduction-edge check above only covers pairs whose
    // witness stays on shared components, so run an exact pairwise scan over
    // shared events to decide the two directions (and locate divergence).
    aBeyondB = false;
    bBeyondA = false;
    const m = shared.length;
    const sCompA = new Int32Array(m);
    const sCompB = new Int32Array(m);
    for (let i = 0; i < m; i++) {
      sCompA[i] = compOfA.get(shared[i]);
      sCompB[i] = compOfB.get(shared[i]);
    }
    for (let j = 0; j < m; j++) {
      const cva = sCompA[j];
      const cvb = sCompB[j];
      let differs = false;
      for (let i = 0; i < m; i++) {
        if (i === j) continue;
        const inA = bitTest(A.reach[sCompA[i]], cva) === 1;
        const inB = bitTest(B.reach[sCompB[i]], cvb) === 1;
        if (inA !== inB) {
          if (inA) aBeyondB = true;
          else bBeyondA = true;
          differs = true;
        }
      }
      if (differs && firstDivergentScan === null) firstDivergentScan = shared[j];
    }
  }
  diffRedEdges.sort((x, y) =>
    x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0,
  );

  // Missing information (reported for UNDECIDED).
  const missingEdges = [];
  for (const e of diffRedEdges) {
    missingEdges.push({ from: e.from, to: e.to, only_in: e.only_in, reason: 'edge_missing' });
  }
  for (const [log, an] of [['a', A], ['b', B]]) {
    for (const e of an.redEdges) {
      if (e.checkFrom === null || e.checkTo === null) {
        missingEdges.push({ from: e.from, to: e.to, only_in: log, reason: 'event_missing' });
      }
    }
    for (const d of an.g.dangling) {
      missingEdges.push({ from: d.from, to: d.to, only_in: log, reason: 'dangling_cause' });
    }
  }
  missingEdges.sort((x, y) =>
    x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0,
  );

  const hasMissing =
    onlyA.length > 0 ||
    onlyB.length > 0 ||
    A.g.dangling.length > 0 ||
    B.g.dangling.length > 0 ||
    aBeyondB !== bBeyondA; // exactly one direction has extra reachability

  let status;
  let firstDivergent = null;
  let minimalFrontier = [];
  if (aBeyondB && bBeyondA) {
    status = 'NOT_EQUAL';
    // Exact first divergent: smallest shared id whose ancestor set differs.
    if (firstDivergentScan !== null) {
      firstDivergent = firstDivergentScan;
    } else {
      outer: for (const v of shared) {
        const cva = compOfA.get(v);
        const cvb = compOfB.get(v);
        for (const u of shared) {
          if (u === v) continue;
          const inA = bitTest(A.reach[compOfA.get(u)], cva) === 1;
          const inB = bitTest(B.reach[compOfB.get(u)], cvb) === 1;
          if (inA !== inB) {
            firstDivergent = v;
            break outer;
          }
        }
      }
    }
    // Minimal inconsistent predecessor set: reduction edges inside the past
    // cone (ancestors or self, in the owning log) of the first divergent
    // event that the two logs disagree on - either a shared causal link one
    // log denies, or a link touching an event the other log never recorded.
    const fdA = compOfA.get(firstDivergent);
    const fdB = compOfB.get(firstDivergent);
    const inCone = (an, compOf, fdComp, id) =>
      id === firstDivergent || bitTest(an.reach[compOf.get(id)], fdComp) === 1;
    minimalFrontier = [];
    for (const e of A.redEdges) {
      if (!inCone(A, compOfA, fdA, e.to)) continue;
      if (e.checkFrom !== null && e.checkTo !== null) {
        if (bitTest(B.reach[compOfB.get(e.checkFrom)], compOfB.get(e.checkTo)) !== 1) {
          minimalFrontier.push({ from: e.from, to: e.to, only_in: 'a' });
        }
      } else {
        minimalFrontier.push({ from: e.from, to: e.to, only_in: 'a', reason: 'event_missing' });
      }
    }
    for (const e of B.redEdges) {
      if (!inCone(B, compOfB, fdB, e.to)) continue;
      if (e.checkFrom !== null && e.checkTo !== null) {
        if (bitTest(A.reach[compOfA.get(e.checkFrom)], compOfA.get(e.checkTo)) !== 1) {
          minimalFrontier.push({ from: e.from, to: e.to, only_in: 'b' });
        }
      } else {
        minimalFrontier.push({ from: e.from, to: e.to, only_in: 'b', reason: 'event_missing' });
      }
    }
    minimalFrontier.sort((x, y) =>
      x.from < y.from ? -1 : x.from > y.from ? 1 : x.to < y.to ? -1 : x.to > y.to ? 1 : 0,
    );
  } else if (hasMissing) {
    status = 'UNDECIDED';
  } else {
    status = 'EQUAL';
  }

  return {
    status,
    first_divergent: firstDivergent,
    minimal_frontier: minimalFrontier,
    missing_edges: status === 'UNDECIDED' ? missingEdges : [],
    counts: {
      a_events: A.g.n,
      b_events: B.g.n,
      shared: shared.length,
      only_a: onlyA.length,
      only_b: onlyB.length,
      a_sccs: A.compCount,
      b_sccs: B.compCount,
    },
    canonical: {
      a: canonicalForm(A),
      b: canonicalForm(B),
    },
  };
}

function canonicalForm(an) {
  const { g, comps, redEdges } = an;
  const sccs = comps
    .map((c) => c.map((i) => g.ids[i]).sort())
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const edges = redEdges.map((e) => [e.from, e.to]);
  return { sccs, reduction_edges: edges };
}
