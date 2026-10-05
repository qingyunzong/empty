// Repair-script search over ledger pairs.
//
// A script is a sequence of cost-1 operations:
//   removeExtra { side, id }                  drop a surplus event
//   addMissing  { side, event }               insert a missing event
//   relink      { side, id, toRelId }         re-point an event's relId
// The goal state is a pair (L', R') whose canonical-form multisets are equal
// and which is internally balanced. Minimal scripts are found by cost-layered
// BFS with relevance pruning; all co-optimal scripts are enumerated (the
// caller caps how many are reported).

import { canonicalForm, signedMinor, SCALE, internallyBalanced, unbalancedGroups } from './automaton.js';

export function multisetDiff(L, R) {
  const rCounts = new Map();
  for (const e of R) {
    const f = canonicalForm(e);
    rCounts.set(f, (rCounts.get(f) || 0) + 1);
  }
  const lOnly = [];
  for (const e of L) {
    const f = canonicalForm(e);
    const c = rCounts.get(f) || 0;
    if (c > 0) rCounts.set(f, c - 1);
    else lOnly.push(e);
  }
  const lCounts = new Map();
  for (const e of L) {
    const f = canonicalForm(e);
    lCounts.set(f, (lCounts.get(f) || 0) + 1);
  }
  const rOnly = [];
  for (const e of R) {
    const f = canonicalForm(e);
    const c = lCounts.get(f) || 0;
    if (c > 0) lCounts.set(f, c - 1);
    else rOnly.push(e);
  }
  return { lOnly, rOnly };
}

function compatKey(e) {
  return [e.account, String(e.amount), e.direction, e.currency].join('|');
}

function eventKey(e) {
  return `${e.id}=${canonicalForm(e)}`;
}

export function stateKey(L, R) {
  return `${L.map(eventKey).sort().join(';')}##${R.map(eventKey).sort().join(';')}`;
}

export function applyOp(state, op) {
  const { L, R } = state;
  const side = op.side === 'left' ? L : R;
  if (op.op === 'removeExtra') {
    const next = side.filter((e) => e.id !== op.id);
    return op.side === 'left' ? { L: next, R } : { L, R: next };
  }
  if (op.op === 'addMissing') {
    let id = String(op.event.id);
    if (side.some((e) => e.id === id)) {
      let n = 1;
      while (side.some((e) => e.id === `${op.event.id}~${n}`)) n += 1;
      id = `${op.event.id}~${n}`;
    }
    const next = side.concat([{ ...op.event, id }]);
    return op.side === 'left' ? { L: next, R } : { L, R: next };
  }
  if (op.op === 'relink') {
    const next = side.map((e) => (e.id === op.id ? { ...e, relId: String(op.toRelId) } : e));
    return op.side === 'left' ? { L: next, R } : { L, R: next };
  }
  throw new Error(`unknown op "${op.op}"`);
}

export function applyScript(L, R, script) {
  let state = { L, R };
  for (const op of script) state = applyOp(state, op);
  return state;
}

export function isGoal(L, R) {
  const d = multisetDiff(L, R);
  return d.lOnly.length === 0 && d.rOnly.length === 0 && internallyBalanced(L) && currencyPure(L);
}

function relCurrencyMap(events) {
  const m = new Map();
  for (const e of events) {
    if (!m.has(e.relId)) m.set(e.relId, e.currency);
  }
  return m;
}

function balancingEvent(group, existing) {
  const base = `__fix_${group.relId}_${group.currency}`;
  let id = base;
  let n = 1;
  while (existing.some((e) => e.id === id)) {
    id = `${base}#${n}`;
    n += 1;
  }
  return {
    id,
    account: group.events[0].account,
    amount: Math.abs(group.net) / SCALE,
    direction: group.net > 0 ? 'credit' : 'debit',
    currency: group.currency,
    relId: group.relId,
  };
}

// Relevance-pruned legal operations from a state. Pruning never removes
// operations that can appear in a minimal script: only events in the
// symmetric difference or in unbalanced groups are worth touching, and
// relinks must either match a cross-ledger counterpart or zero out the
// source or target group. Operations that would mix currencies inside one
// relId are illegal and are not generated.
export function relevantOps(L, R) {
  const ops = [];
  const seen = new Set();
  const push = (op) => {
    const key = canonicalOpString(op);
    if (!seen.has(key)) {
      seen.add(key);
      ops.push(op);
    }
  };
  const relCurL = relCurrencyMap(L);
  const relCurR = relCurrencyMap(R);
  const keepsPure = (relCur, event, relId) => (relCur.get(relId) ?? event.currency) === event.currency;

  const { lOnly, rOnly } = multisetDiff(L, R);
  for (const e of lOnly) {
    push({ op: 'removeExtra', side: 'left', id: e.id });
    if (keepsPure(relCurR, e, e.relId)) push({ op: 'addMissing', side: 'right', event: e });
  }
  for (const e of rOnly) {
    push({ op: 'removeExtra', side: 'right', id: e.id });
    if (keepsPure(relCurL, e, e.relId)) push({ op: 'addMissing', side: 'left', event: e });
  }
  const rByCompat = new Map();
  for (const r of rOnly) {
    const k = compatKey(r);
    if (!rByCompat.has(k)) rByCompat.set(k, []);
    rByCompat.get(k).push(r);
  }
  for (const l of lOnly) {
    for (const r of rByCompat.get(compatKey(l)) || []) {
      if (keepsPure(relCurL, l, r.relId)) {
        push({ op: 'relink', side: 'left', id: l.id, fromRelId: l.relId, toRelId: r.relId });
      }
      if (keepsPure(relCurR, r, l.relId)) {
        push({ op: 'relink', side: 'right', id: r.id, fromRelId: r.relId, toRelId: l.relId });
      }
    }
  }
  for (const [side, cur] of [['left', L], ['right', R]]) {
    const groups = unbalancedGroups(cur);
    const relCur = side === 'left' ? relCurL : relCurR;
    for (const g of groups) {
      for (const e of g.events) {
        push({ op: 'removeExtra', side, id: e.id });
      }
      push({ op: 'addMissing', side, event: balancingEvent(g, cur) });
      for (const g2 of groups) {
        if (g2 === g || g2.currency !== g.currency) continue;
        if (Math.sign(g2.net) !== -Math.sign(g.net)) continue;
        for (const e of g.events) {
          const s = signedMinor(e);
          if (s === g.net || s === -g2.net) {
            if ((relCur.get(g2.relId) ?? e.currency) === e.currency) {
              push({ op: 'relink', side, id: e.id, fromRelId: e.relId, toRelId: g2.relId });
            }
          }
        }
      }
    }
  }
  return ops;
}

export function canonicalOpString(op) {
  if (op.op === 'removeExtra') return `removeExtra|${op.side}|${op.id}`;
  if (op.op === 'relink') return `relink|${op.side}|${op.id}|${op.toRelId}`;
  if (op.op === 'addMissing') return `addMissing|${op.side}|${op.event.id}|${canonicalForm(op.event)}`;
  throw new Error(`unknown op "${op.op}"`);
}

// Admissible lower bound on the minimal script cost. Every operation
// eliminates at most one left-only and at most one right-only event from the
// symmetric difference, and only a compatible relink eliminates two, so
// |lOnly| + |rOnly| - p bounds below (p = max relink matching). When the
// multisets are already equal but the ledgers are unbalanced, a single op
// always breaks multiset equality, hence cost >= 2.
export function lowerBound(L, R) {
  const { lOnly, rOnly } = multisetDiff(L, R);
  if (lOnly.length > 0 || rOnly.length > 0) {
    return lOnly.length + rOnly.length - maxRelinkPairs(lOnly, rOnly);
  }
  return internallyBalanced(L) ? 0 : 2;
}

function extractScripts(goals, scriptCap) {
  const scripts = [];
  const seen = new Set();
  const backtrack = (node, opsRev) => {
    if (scripts.length >= scriptCap) return;
    if (node.parents.length === 0) {
      const script = opsRev.slice().reverse();
      const key = script.map(canonicalOpString).sort().join('\n');
      if (!seen.has(key)) {
        seen.add(key);
        scripts.push(script);
      }
      return;
    }
    for (const p of node.parents) {
      opsRev.push(p.op);
      backtrack(p.node, opsRev);
      opsRev.pop();
      if (scripts.length >= scriptCap) return;
    }
  };
  for (const goal of goals) {
    backtrack(goal, []);
    if (scripts.length >= scriptCap) break;
  }
  return scripts;
}

// Cost-layered BFS for minimal repair scripts.
// Returns { found, minCost, scripts, totalCount, enumerationCapped,
//           exhaustedToK, bounded, states }.
// exhaustedToK === true means every state up to cost k was explored without
// reaching a goal, which proves no script of cost <= k exists.
export function searchScripts(L, R, { k = 5, budget = 100_000, scriptCap = 2_000 } = {}) {
  if (isGoal(L, R)) {
    return { found: true, minCost: 0, scripts: [[]], totalCount: 1, enumerationCapped: false, exhaustedToK: true, bounded: false, states: 1 };
  }
  const start = { L, R, depth: 0, parents: [] };
  const visited = new Map([[stateKey(L, R), start]]);
  let level = [start];
  let states = 1;
  let bounded = false;
  let goals = [];
  for (let depth = 0; depth < k && level.length > 0 && goals.length === 0; depth += 1) {
    const next = [];
    for (const node of level) {
      for (const op of relevantOps(node.L, node.R)) {
        const ns = applyOp({ L: node.L, R: node.R }, op);
        const key = stateKey(ns.L, ns.R);
        let child = visited.get(key);
        if (!child) {
          child = { L: ns.L, R: ns.R, depth: depth + 1, parents: [] };
          visited.set(key, child);
          states += 1;
          if (states > budget) {
            bounded = true;
            break;
          }
          next.push(child);
        }
        if (child.depth === depth + 1) child.parents.push({ node, op });
      }
      if (bounded) break;
    }
    if (bounded) break;
    goals = next.filter((n) => isGoal(n.L, n.R));
    level = next;
  }
  if (goals.length === 0) {
    return {
      found: false,
      minCost: null,
      scripts: [],
      totalCount: 0,
      enumerationCapped: false,
      exhaustedToK: !bounded,
      bounded,
      states,
    };
  }
  const scripts = extractScripts(goals, scriptCap);
  return {
    found: true,
    minCost: goals[0].depth,
    scripts,
    totalCount: scripts.length,
    enumerationCapped: scripts.length >= scriptCap,
    exhaustedToK: false,
    bounded: false,
    states,
  };
}

// ---------------------------------------------------------------------------
// Combinatorial fast path.
//
// Every operation eliminates at most one left-only and at most one right-only
// event from the symmetric difference, and only a relink of a compatible
// pair eliminates two. Hence any script needs at least
//   |lOnly| + |rOnly| - p   (p = max compatible relink matching)
// operations. When the canonical base script (relink matched pairs, drop or
// copy the leftovers) reaches a jointly balanced state, that bound is exact
// and all co-optimal scripts are obtained by enumerating, per operation, its
// symmetric variants (relink left vs right, removeExtra vs addMissing) and
// keeping the combinations that reach the goal.

function groupByCompat(events) {
  const m = new Map();
  for (const e of events) {
    const k = compatKey(e);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(e);
  }
  return m;
}

export function maxRelinkPairs(lOnly, rOnly) {
  const lGroups = groupByCompat(lOnly);
  const rGroups = groupByCompat(rOnly);
  let p = 0;
  for (const [k, ls] of lGroups) {
    const rs = rGroups.get(k);
    if (rs) p += Math.min(ls.length, rs.length);
  }
  return p;
}

// Enumerates maximum compatible matchings (capped). The compatibility graph
// is a disjoint union of complete bipartite graphs per compat key, so every
// maximum matching pairs min(|l_g|, |r_g|) events inside each group.
function enumerateMatchings(lOnly, rOnly, cap) {
  const lGroups = groupByCompat(lOnly);
  const rGroups = groupByCompat(rOnly);
  let matchings = [[]];
  for (const [k, ls] of lGroups) {
    const rs = rGroups.get(k);
    if (!rs) continue;
    const p = Math.min(ls.length, rs.length);
    if (p === 0) continue;
    const groupMatchings = [];
    const usedR = new Array(rs.length).fill(false);
    const rec = (li, acc) => {
      if (groupMatchings.length >= cap) return;
      if (acc.length === p) {
        groupMatchings.push(acc.slice());
        return;
      }
      if (li >= ls.length) return;
      for (let ri = 0; ri < rs.length; ri += 1) {
        if (usedR[ri]) continue;
        usedR[ri] = true;
        acc.push([ls[li], rs[ri]]);
        rec(li + 1, acc);
        acc.pop();
        usedR[ri] = false;
      }
      // Skip ls[li] only if enough events remain to still reach size p.
      if (ls.length - (li + 1) >= p - acc.length) rec(li + 1, acc);
    };
    rec(0, []);
    const next = [];
    for (const prefix of matchings) {
      for (const gm of groupMatchings) {
        next.push(prefix.concat(gm));
        if (next.length >= cap) break;
      }
      if (next.length >= cap) break;
    }
    matchings = next;
  }
  return matchings;
}

function currencyPure(events) {
  const relCur = new Map();
  for (const e of events) {
    const cur = relCur.get(e.relId);
    if (cur === undefined) relCur.set(e.relId, e.currency);
    else if (cur !== e.currency) return false;
  }
  return true;
}

const FAST_SCRIPT_CAP = 2_000;

// Returns null when the symmetric difference is empty (internal-imbalance
// residual, handled by BFS). Otherwise returns either
// { found: true, minCost, scripts, totalCount, enumerationCapped } or
// { found: false, minCostLowerBound } when residual imbalance remains after
// the canonical base script and the bounded BFS must take over.
export function solveFast(L, R, { matchingCap = 64, comboCap = 65_536 } = {}) {
  const { lOnly, rOnly } = multisetDiff(L, R);
  if (lOnly.length === 0 && rOnly.length === 0) return null;
  const p = maxRelinkPairs(lOnly, rOnly);
  const baseCost = lOnly.length + rOnly.length - p;
  const matchings = enumerateMatchings(lOnly, rOnly, matchingCap);

  const canonical = [];
  const pairedL = new Set();
  const pairedR = new Set();
  for (const [l, r] of matchings[0]) {
    pairedL.add(l);
    pairedR.add(r);
    canonical.push({ op: 'relink', side: 'left', id: l.id, fromRelId: l.relId, toRelId: r.relId });
  }
  for (const e of lOnly) if (!pairedL.has(e)) canonical.push({ op: 'removeExtra', side: 'left', id: e.id });
  for (const e of rOnly) if (!pairedR.has(e)) canonical.push({ op: 'addMissing', side: 'left', event: e });
  const afterCanonical = applyScript(L, R, canonical);
  if (!isGoal(afterCanonical.L, afterCanonical.R)) {
    return { found: false, minCostLowerBound: baseCost };
  }

  const scripts = [];
  const seen = new Set();
  let combos = 0;
  let capped = false;
  for (const matching of matchings) {
    if (capped) break;
    const inPairL = new Set();
    const inPairR = new Set();
    const slots = [];
    for (const [l, r] of matching) {
      inPairL.add(l);
      inPairR.add(r);
      slots.push([
        { op: 'relink', side: 'left', id: l.id, fromRelId: l.relId, toRelId: r.relId },
        { op: 'relink', side: 'right', id: r.id, fromRelId: r.relId, toRelId: l.relId },
      ]);
    }
    for (const e of lOnly) {
      if (!inPairL.has(e)) {
        slots.push([
          { op: 'removeExtra', side: 'left', id: e.id },
          { op: 'addMissing', side: 'right', event: e },
        ]);
      }
    }
    for (const e of rOnly) {
      if (!inPairR.has(e)) {
        slots.push([
          { op: 'removeExtra', side: 'right', id: e.id },
          { op: 'addMissing', side: 'left', event: e },
        ]);
      }
    }
    const rec = (i, acc) => {
      if (capped) return;
      if (scripts.length >= FAST_SCRIPT_CAP || combos >= comboCap) {
        capped = true;
        return;
      }
      if (i === slots.length) {
        combos += 1;
        const key = acc.map(canonicalOpString).sort().join('\n');
        if (!seen.has(key)) {
          seen.add(key);
          const after = applyScript(L, R, acc);
          if (isGoal(after.L, after.R)) scripts.push(acc.slice());
        }
        return;
      }
      for (const op of slots[i]) {
        acc.push(op);
        rec(i + 1, acc);
        acc.pop();
        if (capped) return;
      }
    };
    rec(0, []);
  }
  return {
    found: true,
    minCost: baseCost,
    scripts,
    totalCount: scripts.length,
    enumerationCapped: capped || scripts.length >= FAST_SCRIPT_CAP,
  };
}
