// Linearizability checker for payment hold lifecycle histories.
//
// Sequential semantics per hold:
//   hold(amount)    -> freezes `amount`; frozen=amount, captured=0, active.
//   capture(x)      -> requires active hold; moves x from frozen to captured;
//                      total captured never exceeds the held amount; the
//                      chosen increment keeps the running total <= the total
//                      reported in the capture response.
//   cancel          -> requires active hold; releases the remaining frozen
//                      amount (frozen=0, captured kept, available=0).
//   audit           -> observes {frozen, captured, available}; available is
//                      the still-capturable remainder (frozen while active).
//
// A permutation is a candidate linearization iff it respects real-time order
// (op A precedes op B whenever A.respond <= B.invoke); linearization points
// are then assignable inside each [invoke, respond] interval.

import { validateHistory, InvalidHistoryError } from './validate.js';

export function findWitness(history) {
  const ops = validateHistory(history);
  const n = ops.length;

  const predecessors = ops.map(() => new Set());
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && ops[i].respond <= ops[j].invoke) predecessors[j].add(i);
    }
  }

  // Candidate cumulative-captured targets for a capture: only constraint
  // boundaries matter (response totals and audit observations on this hold).
  const targetValues = new Map();
  for (const op of ops) {
    if (op.op === 'audit' || op.op === 'capture') {
      if (!targetValues.has(op.holdId)) targetValues.set(op.holdId, new Set());
      targetValues.get(op.holdId).add(op.op === 'audit' ? op.result.captured : op.captured);
    }
  }

  const holds = new Map(); // holdId -> {amount, frozen, captured, active}
  const used = new Array(n).fill(false);
  const order = [];
  const allocations = new Map(); // op index -> captured increment

  function captureTargets(op, st) {
    const lo = st.captured;
    const hi = Math.min(st.amount, st.captured + op.amount, op.captured);
    if (hi < lo) return [];
    const set = new Set([lo, hi]);
    for (const v of targetValues.get(op.holdId) ?? []) {
      if (v >= lo && v <= hi) set.add(v);
    }
    return [...set].sort((a, b) => a - b);
  }

  function dfs() {
    if (order.length === n) return true;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      let ready = true;
      for (const p of predecessors[i]) {
        if (!used[p]) { ready = false; break; }
      }
      if (!ready) continue;
      const op = ops[i];

      if (op.op === 'hold') {
        holds.set(op.holdId, { amount: op.amount, frozen: op.amount, captured: 0, active: true });
        used[i] = true; order.push(i);
        if (dfs()) return true;
        order.pop(); used[i] = false; holds.delete(op.holdId);
      } else if (op.op === 'capture') {
        const st = holds.get(op.holdId);
        if (!st || !st.active) continue;
        // A response can never report a total above the held amount.
        if (op.captured > st.amount) continue;
        for (const target of captureTargets(op, st)) {
          const prevCaptured = st.captured;
          const prevFrozen = st.frozen;
          st.captured = target;
          st.frozen = st.amount - target;
          used[i] = true; order.push(i); allocations.set(i, target - prevCaptured);
          if (dfs()) return true;
          allocations.delete(i); order.pop(); used[i] = false;
          st.captured = prevCaptured; st.frozen = prevFrozen;
        }
      } else if (op.op === 'cancel') {
        const st = holds.get(op.holdId);
        if (!st || !st.active) continue;
        const prevFrozen = st.frozen;
        st.active = false; st.frozen = 0;
        used[i] = true; order.push(i);
        if (dfs()) return true;
        order.pop(); used[i] = false;
        st.active = true; st.frozen = prevFrozen;
      } else { // audit
        const st = holds.get(op.holdId);
        if (!st) continue;
        const available = st.active ? st.frozen : 0;
        if (op.result.frozen !== st.frozen ||
            op.result.captured !== st.captured ||
            op.result.available !== available) continue;
        used[i] = true; order.push(i);
        if (dfs()) return true;
        order.pop(); used[i] = false;
      }
    }
    return false;
  }

  if (!dfs()) return null;

  // Assign linearization points inside [invoke, respond]; feasibility is
  // guaranteed because the order respects real-time precedence.
  let previous = -Infinity;
  const witness = order.map((i) => {
    const op = ops[i];
    const lp = Math.max(op.invoke, previous);
    previous = lp;
    const entry = { id: op.id, op: op.op, linearizationPoint: lp };
    if (op.holdId !== undefined) entry.holdId = op.holdId;
    if (op.op === 'capture') entry.allocated = allocations.get(i);
    return entry;
  });

  const audits = [];
  for (const i of order) {
    const op = ops[i];
    if (op.op === 'audit') {
      audits.push({ id: op.id, holdId: op.holdId, ...op.result });
    }
  }
  return { witness, audits };
}

function* combinations(n, k, start = 0, prefix = []) {
  if (prefix.length === k) {
    yield prefix;
    return;
  }
  for (let i = start; i <= n - (k - prefix.length); i++) {
    yield* combinations(n, k, i + 1, [...prefix, i]);
  }
}

// Minimum-size subset of operations whose sub-history is not linearizable.
export function findMinimalConflict(history) {
  const ops = validateHistory(history);
  const n = ops.length;
  for (let k = 1; k <= n; k++) {
    for (const idxs of combinations(n, k)) {
      const sub = { operations: idxs.map((i) => ops[i]) };
      let witness;
      try {
        witness = findWitness(sub);
      } catch (err) {
        if (err instanceof InvalidHistoryError) continue; // not a well-formed sub-history
        throw err;
      }
      if (witness === null) return idxs.map((i) => ops[i].id);
    }
  }
  return null;
}

export function linearize(history) {
  const found = findWitness(history);
  if (found) {
    return { status: 'LINEARIZABLE', witness: found.witness, audits: found.audits };
  }
  return { status: 'NOT_LINEARIZABLE', conflict: findMinimalConflict(history) };
}
