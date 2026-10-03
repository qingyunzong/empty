// Backtracking linearizability checker.
//
// A linearization is a permutation of the ops such that:
//  1. real-time order is respected: if op A responded (responseTime) at or
//     before op B was invoked (invocationTime), A precedes B;
//  2. replaying the ops in that order on the sequential model reproduces
//     every recorded response (ok flags and read results).
//
// Given such an order, linearization points inside [invocationTime,
// responseTime] always exist (greedy assignment lp_i = max(lp_{i-1},
// invocation_i) never exceeds response_i in a real-time-consistent order),
// and we compute them for the witness.

import {
  createState,
  cloneState,
  applyOp,
  responseMatches,
  serializeState,
} from './model.js';

export function checkLinearizable(ops, options = {}) {
  const initialBalances = options.initial ?? {};
  const n = ops.length;

  // deepest contradiction seen, used to explain conflicts
  let bestFailure = null;

  const noteFailure = (path, op, actual) => {
    if (bestFailure && bestFailure.path.length > path.length) return;
    let reason;
    if (actual.ok !== op.ok) {
      reason = actual.ok
        ? `recorded ok=false but the operation would succeed`
        : `recorded ok=true but ${actual.failureReason}`;
    } else {
      reason =
        `recorded result {balance:${op.result.balance}, frozen:${op.result.frozen}} ` +
        `but actual is {balance:${actual.result.balance}, frozen:${actual.result.frozen}}`;
    }
    bestFailure = { path: [...path], op, reason };
  };

  const memo = new Set(); // "remainingMask|state" combos that cannot be completed

  const search = (state, remaining, path) => {
    if (remaining.length === 0) return [];
    const key = `${remaining.join('.')}|${serializeState(state)}`;
    if (memo.has(key)) return null;

    for (let k = 0; k < remaining.length; k++) {
      const i = remaining[k];
      const op = ops[i];
      // op must be a minimal element of the remaining real-time partial order
      let minimal = true;
      for (const j of remaining) {
        if (j !== i && ops[j].responseTime <= op.invocationTime) {
          minimal = false;
          break;
        }
      }
      if (!minimal) continue;

      const nextState = cloneState(state);
      const actual = applyOp(nextState, op);
      if (!responseMatches(actual, op)) {
        noteFailure(path, op, actual);
        continue;
      }
      const rest = remaining.slice(0, k).concat(remaining.slice(k + 1));
      path.push(op.opId);
      const sub = search(nextState, rest, path);
      if (sub) return [i, ...sub];
      path.pop();
    }

    memo.add(key);
    return null;
  };

  const startState = createState(initialBalances);
  const order = search(startState, ops.map((_, i) => i), []);

  if (order) {
    return {
      linearizable: true,
      witness: order.map((i) => ops[i].opId),
      linearizationPoints: assignLinearizationPoints(order.map((i) => ops[i])),
    };
  }

  return {
    linearizable: false,
    conflict: describeConflict(bestFailure),
  };
}

function assignLinearizationPoints(orderedOps) {
  const points = [];
  let previous = -Infinity;
  for (const op of orderedOps) {
    const lp = Math.max(previous, op.invocationTime);
    points.push(lp);
    previous = lp;
  }
  return points;
}

function describeConflict(bestFailure) {
  if (!bestFailure) {
    return 'no linearization consistent with the recorded responses exists';
  }
  const prefix =
    bestFailure.path.length > 0
      ? `after [${bestFailure.path.join(', ')}], `
      : '';
  const op = bestFailure.op;
  return (
    `no valid linearization; deepest contradiction: ${prefix}` +
    `op "${op.opId}" (${op.type}${op.reserveId ? ` ${op.reserveId}` : ''}) ` +
    `cannot be placed anywhere: ${bestFailure.reason}`
  );
}
