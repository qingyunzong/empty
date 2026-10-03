'use strict';

const {
  contentKey,
  chainsByAccount,
  isBalancedEvents,
  relCurrencyMap,
} = require('./model');
const { jointAcceptable } = require('./automaton');

function stateKey(L, R) {
  return JSON.stringify([L.map(contentKey), R.map(contentKey)]);
}

function opKey(op) {
  return JSON.stringify(op);
}

function scriptKey(ops) {
  return ops.map(opKey).sort().join('|');
}

// Generate all cost-1 repair operations applicable to state (L, R).
// addMissing appends a copy of the other book's event at the end of a book
// (end of its account chain); removeExtra deletes an event; relink changes an
// event's relation id. Operations that would introduce a currency mix inside
// a relation group are never generated.
function genOps(L, R) {
  const ops = [];
  const byIdL = new Map(L.map((e) => [e.id, e]));
  const byIdR = new Map(R.map((e) => [e.id, e]));
  const currL = relCurrencyMap(L);
  const currR = relCurrencyMap(R);
  const canPlace = (currMap, ev) => !currMap.has(ev.rel) || currMap.get(ev.rel) === ev.currency;

  let asymmetric = false;
  for (const e of L) {
    if (!byIdR.has(e.id)) {
      asymmetric = true;
      ops.push({ op: 'removeExtra', book: 'left', id: e.id });
      if (canPlace(currR, e)) ops.push({ op: 'addMissing', book: 'right', event: { ...e } });
    }
  }
  for (const e of R) {
    if (!byIdL.has(e.id)) {
      asymmetric = true;
      ops.push({ op: 'removeExtra', book: 'right', id: e.id });
      if (canPlace(currL, e)) ops.push({ op: 'addMissing', book: 'left', event: { ...e } });
    }
  }
  for (const e of L) {
    const o = byIdR.get(e.id);
    if (!o || contentKey(o) === contentKey(e)) continue;
    asymmetric = true;
    const onlyRel =
      e.account === o.account &&
      e.amount === o.amount &&
      e.direction === o.direction &&
      e.currency === o.currency &&
      e.rel !== o.rel;
    let relinked = false;
    if (onlyRel) {
      if (canPlace(currL, { ...e, rel: o.rel })) {
        ops.push({ op: 'relink', book: 'left', id: e.id, rel: o.rel });
        relinked = true;
      }
      if (canPlace(currR, { ...o, rel: e.rel })) {
        ops.push({ op: 'relink', book: 'right', id: e.id, rel: e.rel });
        relinked = true;
      }
    }
    if (!relinked) {
      ops.push({ op: 'removeExtra', book: 'left', id: e.id });
      ops.push({ op: 'removeExtra', book: 'right', id: e.id });
    }
  }
  if (!asymmetric) {
    // Identical content multisets: only balance (relink) or per-account order
    // (remove + re-add in a later layer) can be broken.
    if (!isBalancedEvents(L)) {
      const allRels = [...new Set([...L, ...R].map((e) => e.rel))].sort();
      for (const e of L) {
        for (const rel of allRels) {
          if (rel !== e.rel && canPlace(currL, { ...e, rel })) {
            ops.push({ op: 'relink', book: 'left', id: e.id, rel });
          }
        }
      }
      for (const e of R) {
        for (const rel of allRels) {
          if (rel !== e.rel && canPlace(currR, { ...e, rel })) {
            ops.push({ op: 'relink', book: 'right', id: e.id, rel });
          }
        }
      }
    }
    const cL = chainsByAccount(L);
    const cR = chainsByAccount(R);
    const differs = (a, b) => a.length !== b.length || a.some((v, i) => v !== b[i]);
    let orderDiff = false;
    for (const [account, ids] of cL) {
      if (differs(ids, cR.get(account) || [])) orderDiff = true;
    }
    if (orderDiff) {
      for (const [account, ids] of cL) {
        if (differs(ids, cR.get(account) || [])) {
          for (const id of ids) ops.push({ op: 'removeExtra', book: 'left', id });
        }
      }
      for (const [account, ids] of cR) {
        if (differs(ids, cL.get(account) || [])) {
          for (const id of ids) ops.push({ op: 'removeExtra', book: 'right', id });
        }
      }
    }
  }
  const dedup = new Map();
  for (const op of ops) dedup.set(opKey(op), op);
  return [...dedup.values()].sort((a, b) => (opKey(a) < opKey(b) ? -1 : 1));
}

function applyOp(L, R, op) {
  const target = op.book === 'left' ? L : R;
  let next;
  if (op.op === 'removeExtra') {
    next = target.filter((e) => e.id !== op.id);
  } else if (op.op === 'addMissing') {
    next = [...target, { ...op.event }];
  } else if (op.op === 'relink') {
    next = target.map((e) => (e.id === op.id ? { ...e, rel: op.rel } : e));
  } else {
    throw new Error(`unknown op ${op.op}`);
  }
  return op.book === 'left' ? [next, R] : [L, next];
}

function applyScript(L, R, ops) {
  let curL = L;
  let curR = R;
  for (const op of ops) [curL, curR] = applyOp(curL, curR, op);
  return [curL, curR];
}

// Uniform-cost (BFS by layer) search for minimal repair scripts. All scripts
// reaching a jointly acceptable state at the minimal depth are collected,
// deduplicated as op multisets, and capped at maxScripts (default 20).
// Statuses:
//   'found'     — minimal cost and all tied scripts (up to the cap)
//   'bound'     — no script of cost <= k; provenLowerBound = k + 1 when the
//                 whole layer was explored, or the first incompletely explored
//                 depth when the state cap was hit (never reported as "no diff")
//   'exhausted' — the finite state space was fully explored without a goal
function minRepairScripts(L0, R0, k, opts = {}) {
  const maxStates = opts.maxStates || 100000;
  const maxPathsPerState = opts.maxPathsPerState || 25;
  const maxScripts = opts.maxScripts || 20;
  let truncated = false;
  const seen = new Set([stateKey(L0, R0)]);
  let frontier = [{ L: L0, R: R0, paths: [[]] }];
  for (let depth = 1; depth <= k; depth += 1) {
    const next = new Map();
    const goalScripts = new Map();
    let overflow = false;
    for (const node of frontier) {
      for (const op of genOps(node.L, node.R)) {
        const [L2, R2] = applyOp(node.L, node.R, op);
        const childPaths = node.paths.map((p) => [...p, op]);
        if (jointAcceptable(L2, R2)) {
          for (const p of childPaths) goalScripts.set(scriptKey(p), p);
          continue;
        }
        const key = stateKey(L2, R2);
        const existing = next.get(key);
        if (existing) {
          for (const p of childPaths) {
            const sk = scriptKey(p);
            if (existing.paths.some((q) => scriptKey(q) === sk)) continue;
            if (existing.paths.length >= maxPathsPerState) {
              truncated = true;
              break;
            }
            existing.paths.push(p);
          }
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > maxStates) {
          overflow = true;
          break;
        }
        if (childPaths.length > maxPathsPerState) truncated = true;
        next.set(key, { L: L2, R: R2, paths: childPaths.slice(0, maxPathsPerState) });
      }
      if (overflow) break;
    }
    if (goalScripts.size > 0) {
      const all = [...goalScripts.values()].sort((a, b) => (scriptKey(a) < scriptKey(b) ? -1 : 1));
      if (all.length > maxScripts) truncated = true;
      return { status: 'found', cost: depth, scripts: all.slice(0, maxScripts), truncated };
    }
    if (overflow) return { status: 'bound', provenLowerBound: depth, truncated: true };
    if (next.size === 0) return { status: 'exhausted', provenLowerBound: null };
    frontier = [...next.values()];
  }
  return { status: 'bound', provenLowerBound: k + 1, truncated };
}

module.exports = { genOps, applyOp, applyScript, minRepairScripts, scriptKey };
