// Serializability checking for a merged transaction history.
//
// A history is a set of transactions {id, reads: {k: v|null}, writes: {k: v}}.
// It is serializable iff there exists a serial order of the transactions
// such that (a) every read observes the value written by the latest preceding
// writer (or null = initial state) and (b) the final state equals the merged
// state.
//
// checkSerializable builds a constraint graph with the three classic conflict
// edge kinds:
//   WR (read-from)      Tw -> T   when T read the value Tw wrote
//   WW (write-order)    Tw' -> Tw for writers of the same key, resolved by
//                                 the merged final state (the writer of the
//                                 final value must be last)
//   RW (anti-dependency) T -> Tw' when T read key k from Tw and Tw' also
//                                 writes k; disjunctive: Tw' -> Tw OR T -> Tw'
//
// Single-candidate WR/WW constraints are hard edges; remaining disjunctions
// are resolved by an exact DPLL-style search with unit propagation, so the
// verdict agrees with brute-force enumeration of all serial permutations
// (bruteForceSerializable below, used as the test oracle).
//
// When no serial order exists, a concrete conflict cycle is reported: either
// a cycle in the hard-edge graph, or a cycle forced under every consistent
// edge orientation (witnessed from the first failing search branch).

import { clockLt } from './clock.js';

const SEP = '\u0001';
const ekey = (a, b) => a + SEP + b;

function buildAdj(ids, edgeSet) {
  const adj = new Map(ids.map((i) => [i, []]));
  for (const e of edgeSet) {
    const [a, b] = e.split(SEP);
    if (adj.has(a)) adj.get(a).push(b);
  }
  return adj;
}

function hasPath(adj, from, to) {
  if (from === to) return true;
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const u = queue.shift();
    for (const w of adj.get(u) ?? []) {
      if (w === to) return true;
      if (!seen.has(w)) {
        seen.add(w);
        queue.push(w);
      }
    }
  }
  return false;
}

function findPath(adj, from, to) {
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const u = queue.shift();
    if (u === to) {
      const path = [];
      for (let n = to; n !== null; n = prev.get(n)) path.unshift(n);
      return path;
    }
    for (const w of adj.get(u) ?? []) {
      if (!prev.has(w)) {
        prev.set(w, u);
        queue.push(w);
      }
    }
  }
  return null;
}

// Returns a cycle as [n0, n1, ..., n0] or null.
export function findCycle(ids, adj) {
  const state = new Map(ids.map((i) => [i, 0]));
  const stack = [];
  let result = null;
  function dfs(u) {
    state.set(u, 1);
    stack.push(u);
    for (const w of adj.get(u) ?? []) {
      if (result) return;
      const s = state.get(w) ?? 0;
      if (s === 1) {
        result = stack.slice(stack.indexOf(w));
        result.push(w);
        return;
      }
      if (s === 0) dfs(w);
    }
    stack.pop();
    state.set(u, 2);
  }
  for (const id of ids) {
    if (result) break;
    if (state.get(id) === 0) dfs(id);
  }
  return result;
}

export function topoSort(ids, adj) {
  const indeg = new Map(ids.map((i) => [i, 0]));
  for (const id of ids) {
    for (const w of adj.get(id) ?? []) indeg.set(w, (indeg.get(w) ?? 0) + 1);
  }
  const ready = ids.filter((i) => indeg.get(i) === 0).sort();
  const order = [];
  while (ready.length) {
    const u = ready.shift();
    order.push(u);
    for (const w of adj.get(u) ?? []) {
      indeg.set(w, indeg.get(w) - 1);
      if (indeg.get(w) === 0) {
        const pos = ready.findIndex((x) => x > w);
        if (pos === -1) ready.push(w);
        else ready.splice(pos, 0, w);
      }
    }
  }
  return order;
}

// Deterministic merge order: causal (vector-clock) topological order with
// transaction-id tie-break. Every replica that knows the same transaction
// set computes the same merged state from this order.
export function canonicalOrder(txns) {
  const remaining = new Map(txns.map((t) => [t.id, t]));
  const order = [];
  while (remaining.size) {
    let best = null;
    for (const [id, t] of remaining) {
      let ready = true;
      for (const [id2, t2] of remaining) {
        if (id2 !== id && clockLt(t2.clock, t.clock)) {
          ready = false;
          break;
        }
      }
      if (ready && (best === null || id < best)) best = id;
    }
    order.push(best);
    remaining.delete(best);
  }
  return order;
}

export function replayState(txns, order) {
  const byId = new Map(txns.map((t) => [t.id, t]));
  const state = {};
  for (const id of order) {
    const t = byId.get(id);
    if (!t) continue;
    Object.assign(state, t.writes);
  }
  return state;
}

export function statesEqual(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function checkSerializable(txns, finalState) {
  const ids = txns.map((t) => t.id);
  const byId = new Map(txns.map((t) => [t.id, t]));

  const writersOf = new Map(); // key -> [txnId]
  for (const t of txns) {
    for (const k of Object.keys(t.writes)) {
      const arr = writersOf.get(k) ?? [];
      arr.push(t.id);
      writersOf.set(k, arr);
    }
  }

  const hard = new Set();
  const rfList = []; // {txn, key, value, candidates: [txnId] | null(initial)}
  for (const t of txns) {
    for (const [k, v] of Object.entries(t.reads ?? {})) {
      const ws = (writersOf.get(k) ?? []).filter((w) => w !== t.id);
      if (v === null) {
        // Read the initial state: every writer of k must come after T.
        for (const w of ws) hard.add(ekey(t.id, w));
        rfList.push({ txn: t.id, key: k, value: v, candidates: null });
      } else {
        rfList.push({
          txn: t.id,
          key: k,
          value: v,
          candidates: ws.filter((w) => byId.get(w).writes[k] === v),
        });
      }
    }
  }
  for (const r of rfList) {
    if (r.candidates && r.candidates.length === 0) {
      return {
        serializable: false,
        cycle: null,
        reason: `unmatched read: ${r.txn} read ${r.key}=${JSON.stringify(r.value)} written by nobody`,
      };
    }
  }

  const fwList = []; // {key, writers, candidates}
  for (const [k, ws] of writersOf) {
    const fv = finalState[k];
    if (fv === undefined) {
      return {
        serializable: false,
        cycle: null,
        reason: `final state lacks key ${k} but writers exist: ${ws.join(', ')}`,
      };
    }
    const cand = ws.filter((w) => byId.get(w).writes[k] === fv);
    if (cand.length === 0) {
      return {
        serializable: false,
        cycle: null,
        reason: `no writer produced final value of ${k}=${JSON.stringify(fv)}`,
      };
    }
    fwList.push({ key: k, writers: ws, candidates: cand });
  }

  // First failure context, used to build a conflict-cycle witness.
  let failure = null;
  const noteFailure = (f) => {
    if (!failure) failure = f;
  };

  function solve(rfAssign, fwAssign, anti) {
    for (;;) {
      const edges = new Set(hard);
      for (const e of anti) edges.add(e);
      for (const [i, w] of rfAssign) edges.add(ekey(w, rfList[i].txn));
      for (const [k, w] of fwAssign) {
        const fw = fwList.find((f) => f.key === k);
        for (const o of fw.writers) if (o !== w) edges.add(ekey(o, w));
      }
      const adj = buildAdj(ids, edges);
      let changed = false;

      // Unit-propagate read-from choices: candidate w is impossible if the
      // edge w -> reader would close a cycle.
      for (let i = 0; i < rfList.length; i++) {
        const r = rfList[i];
        if (!r.candidates || rfAssign.has(i)) continue;
        const viable = r.candidates.filter((w) => !hasPath(adj, r.txn, w));
        if (viable.length === 0) {
          noteFailure({ kind: 'readfrom', read: r, edges, adj });
          return null;
        }
        if (viable.length === 1) {
          rfAssign.set(i, viable[0]);
          changed = true;
        }
      }
      // Unit-propagate final-writer choices: candidate w is impossible if
      // some other writer is already forced after it.
      for (const f of fwList) {
        if (fwAssign.has(f.key)) continue;
        const viable = f.candidates.filter((w) =>
          f.writers.every((o) => o === w || !hasPath(adj, w, o)));
        if (viable.length === 0) {
          noteFailure({ kind: 'finalwriter', fw: f, edges, adj });
          return null;
        }
        if (viable.length === 1) {
          fwAssign.set(f.key, viable[0]);
          changed = true;
        }
      }
      // Unit-propagate anti-dependencies for resolved read-froms.
      for (const [i, w] of rfAssign) {
        const r = rfList[i];
        for (const o of writersOf.get(r.key) ?? []) {
          if (o === w || o === r.txn) continue;
          const e1 = ekey(o, w); // other writer before chosen writer
          const e2 = ekey(r.txn, o); // reader before other writer
          if (edges.has(e1) || edges.has(e2)) continue;
          const p1 = hasPath(adj, w, o);
          const p2 = hasPath(adj, o, r.txn);
          if (p1 && p2) {
            noteFailure({ kind: 'antidep', read: r, writer: w, other: o, edges, adj });
            return null;
          }
          if (p1) {
            anti.add(e2);
            changed = true;
          } else if (p2) {
            anti.add(e1);
            changed = true;
          }
        }
      }
      if (changed) continue;

      // Fixpoint reached: branch on the first undecided choice.
      const rfU = rfList.findIndex((r, i) => r.candidates && !rfAssign.has(i));
      if (rfU >= 0) {
        const r = rfList[rfU];
        for (const w of r.candidates) {
          if (hasPath(adj, r.txn, w)) continue;
          const res = solve(new Map(rfAssign).set(rfU, w), new Map(fwAssign), new Set(anti));
          if (res) return res;
        }
        return null;
      }
      const fwU = fwList.find((f) => !fwAssign.has(f.key));
      if (fwU) {
        for (const w of fwU.candidates) {
          if (!fwU.writers.every((o) => o === w || !hasPath(adj, w, o))) continue;
          const res = solve(new Map(rfAssign), new Map(fwAssign).set(fwU.key, w), new Set(anti));
          if (res) return res;
        }
        return null;
      }
      const cyc = findCycle(ids, adj);
      if (cyc) {
        noteFailure({ kind: 'cycle', cycle: cyc });
        return null;
      }
      return edges;
    }
  }

  const solved = solve(new Map(), new Map(), new Set());
  if (solved) {
    const adj = buildAdj(ids, solved);
    const order = topoSort(ids, adj);
    const replayed = replayState(txns, order);
    return { serializable: true, order, replayed, consistent: statesEqual(replayed, finalState) };
  }

  // Build a concrete conflict-cycle witness from the recorded failure.
  let cycle = null;
  if (failure) {
    if (failure.kind === 'cycle') {
      cycle = failure.cycle;
    } else if (failure.kind === 'readfrom') {
      const r = failure.read;
      const w = r.candidates[0];
      const path = findPath(failure.adj, r.txn, w);
      if (path) cycle = [...path, r.txn];
    } else if (failure.kind === 'finalwriter') {
      const f = failure.fw;
      outer: for (const w of f.candidates) {
        for (const o of f.writers) {
          if (o === w) continue;
          const path = findPath(failure.adj, w, o);
          if (path) {
            cycle = [...path, w];
            break outer;
          }
        }
      }
    } else if (failure.kind === 'antidep') {
      const edges = new Set(failure.edges);
      edges.add(ekey(failure.read.txn, failure.other));
      cycle = findCycle(ids, buildAdj(ids, edges));
    }
  }
  if (!cycle) {
    const adj = buildAdj(ids, hard);
    cycle = findCycle(ids, adj);
  }
  return { serializable: false, cycle, reason: failure?.kind };
}

// Reference oracle: enumerate every serial permutation and check read
// consistency plus final state. Feasible only for small histories; used in
// tests to validate checkSerializable.
export function bruteForceSerializable(txns, finalState) {
  const n = txns.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  let found = false;

  function visit(state, remaining) {
    if (found) return;
    if (remaining.length === 0) {
      if (statesEqual(state, finalState)) found = true;
      return;
    }
    for (let i = 0; i < remaining.length; i++) {
      const t = txns[remaining[i]];
      let ok = true;
      for (const [k, v] of Object.entries(t.reads ?? {})) {
        if ((state[k] ?? null) !== v) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      const next = { ...state, ...t.writes };
      visit(next, [...remaining.slice(0, i), ...remaining.slice(i + 1)]);
      if (found) return;
    }
  }

  visit({}, idx);
  return found;
}
