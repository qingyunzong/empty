// Linearizability checker: depth-first search over the real-time partial
// order with memoization on (placed set, state). Returns a witness order
// with concrete linearization points when linearizable.

import {
  validateHistory,
  createInitialState,
  cloneState,
  applyOp,
  responseMatches,
  hashState,
} from './model.js';

function buildPrecedence(history) {
  const n = history.length;
  const predCount = new Array(n).fill(0);
  const succ = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && history[i].responseTime <= history[j].invocationTime) {
        succ[i].push(j);
        predCount[j]++;
      }
    }
  }
  return { predCount, succ };
}

// Greedy point assignment is always feasible for an order that respects the
// real-time precedence: if some predecessor k had invocationTime greater
// than op i's responseTime, then i would have to precede k, a contradiction.
function assignPoints(order, history) {
  const points = [];
  let prev = -Infinity;
  for (const i of order) {
    const p = Math.max(history[i].invocationTime, prev);
    points.push(p);
    prev = p;
  }
  return points;
}

export function checkLinearizability(history, options = {}) {
  const initialBalance = options.initialBalance ?? 0;
  validateHistory(history);
  const n = history.length;
  const { predCount, succ } = buildPrecedence(history);

  const placed = new Array(n).fill(false);
  const available = [];
  for (let i = 0; i < n; i++) if (predCount[i] === 0) available.push(i);
  let remaining = n;
  const memo = new Set();
  let explored = 0;

  function placedKey(state) {
    let bits = '';
    for (let i = 0; i < n; i++) bits += placed[i] ? '1' : '0';
    return `${bits}|${hashState(state)}`;
  }

  function dfs(state) {
    if (remaining === 0) return [];
    const key = placedKey(state);
    if (memo.has(key)) return null;
    explored++;
    const snapshot = available.slice();
    for (const i of snapshot) {
      const next = cloneState(state);
      const result = applyOp(next, history[i]);
      if (!responseMatches(history[i], result)) continue;
      available.splice(available.indexOf(i), 1);
      placed[i] = true;
      remaining--;
      const added = [];
      for (const j of succ[i]) {
        if (--predCount[j] === 0) {
          available.push(j);
          added.push(j);
        }
      }
      const rest = dfs(next);
      if (rest) return [i, ...rest];
      for (const j of succ[i]) predCount[j]++;
      for (const j of added) available.splice(available.lastIndexOf(j), 1);
      remaining++;
      placed[i] = false;
      available.push(i);
    }
    memo.add(key);
    return null;
  }

  const order = dfs(createInitialState(initialBalance));
  if (order) {
    const points = assignPoints(order, history);
    return {
      linearizable: true,
      witness: order.map((i, k) => ({
        opId: history[i].opId,
        client: history[i].client,
        type: history[i].type,
        account: history[i].account,
        linearizationPoint: points[k],
      })),
      order: order.map((i) => history[i].opId),
      statesExplored: explored,
    };
  }
  return {
    linearizable: false,
    reason:
      `no sequential ordering of the ${n} operation(s) respects the real-time ` +
      `order and the reserve/commit/cancel/read semantics (explored ${explored} state(s))`,
    statesExplored: explored,
  };
}
