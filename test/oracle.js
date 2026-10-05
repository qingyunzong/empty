// Independent brute-force oracle used to cross-check the optimized solver.
// It performs a plain BFS over the same (L, R) state space but with a full,
// unpruned operation alphabet (any removable id, any addable event from the
// opposite ledger or any balancing counterpart, any relink to any existing
// relId), reimplemented here without sharing the solver's pruning logic.

import { canonicalForm, signedMinor, SCALE, unbalancedGroups } from '../src/automaton.js';
import { multisetDiff, stateKey, isGoal } from '../src/diff.js';

function relCurrencies(events) {
  const m = new Map();
  for (const e of events) if (!m.has(e.relId)) m.set(e.relId, e.currency);
  return m;
}

function fullAlphabet(L, R) {
  const ops = [];
  const relCurL = relCurrencies(L);
  const relCurR = relCurrencies(R);
  const relIds = new Set([...L, ...R].map((e) => e.relId));
  for (const e of L) ops.push({ op: 'removeExtra', side: 'left', id: e.id });
  for (const e of R) ops.push({ op: 'removeExtra', side: 'right', id: e.id });
  for (const e of L) {
    if ((relCurR.get(e.relId) ?? e.currency) === e.currency) ops.push({ op: 'addMissing', side: 'right', event: e });
  }
  for (const e of R) {
    if ((relCurL.get(e.relId) ?? e.currency) === e.currency) ops.push({ op: 'addMissing', side: 'left', event: e });
  }
  for (const [side, cur, relCur] of [['left', L, relCurL], ['right', R, relCurR]]) {
    for (const g of unbalancedGroups(cur)) {
      ops.push({
        op: 'addMissing',
        side,
        event: {
          id: `__oracle_fix_${g.relId}_${g.currency}`,
          account: g.events[0].account,
          amount: Math.abs(g.net) / SCALE,
          direction: g.net > 0 ? 'credit' : 'debit',
          currency: g.currency,
          relId: g.relId,
        },
      });
    }
    for (const e of cur) {
      for (const relId of relIds) {
        if (relId !== e.relId && (relCur.get(relId) ?? e.currency) === e.currency) {
          ops.push({ op: 'relink', side, id: e.id, toRelId: relId });
        }
      }
    }
  }
  return ops;
}

function applyOp({ L, R }, op) {
  const side = op.side === 'left' ? L : R;
  if (op.op === 'removeExtra') {
    const next = side.filter((e) => e.id !== op.id);
    return op.side === 'left' ? { L: next, R } : { L, R: next };
  }
  if (op.op === 'addMissing') {
    let id = String(op.event.id);
    let n = 1;
    while (side.some((e) => e.id === id)) {
      id = `${op.event.id}~${n}`;
      n += 1;
    }
    const next = side.concat([{ ...op.event, id }]);
    return op.side === 'left' ? { L: next, R } : { L, R: next };
  }
  if (op.op === 'relink') {
    const next = side.map((e) => (e.id === op.id ? { ...e, relId: String(op.toRelId) } : e));
    return op.side === 'left' ? { L: next, R } : { L, R: next };
  }
  throw new Error(`unknown op ${op.op}`);
}

// Returns the minimal script cost, or null when no goal was reached within
// maxDepth / stateCap (the caller must treat that as "unknown", never as
// "no difference").
export function oracleMinCost(L, R, { maxDepth = 6, stateCap = 500_000 } = {}) {
  if (isGoal(L, R)) return 0;
  const seen = new Set([stateKey(L, R)]);
  let level = [{ L, R }];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = [];
    for (const node of level) {
      for (const op of fullAlphabet(node.L, node.R)) {
        const ns = applyOp(node, op);
        const key = stateKey(ns.L, ns.R);
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > stateCap) return null;
        if (isGoal(ns.L, ns.R)) return depth;
        next.push(ns);
      }
    }
    level = next;
    if (level.length === 0) return null;
  }
  return null;
}

export { canonicalForm, multisetDiff };
