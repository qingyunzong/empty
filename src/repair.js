'use strict';

const HARD_CAP = 50000;

function applyPlan(events, ops) {
  const insertsBefore = new Map();
  const deletes = new Set();
  for (const op of ops) {
    if (op.op === 'insert') {
      if (!insertsBefore.has(op.pos)) insertsBefore.set(op.pos, []);
      insertsBefore.get(op.pos).push(op.event);
    } else {
      deletes.add(op.pos);
    }
  }
  const out = [];
  for (let i = 0; i <= events.length; i += 1) {
    for (const e of insertsBefore.get(i) ?? []) out.push(e);
    if (i < events.length && !deletes.has(i)) out.push(events[i]);
  }
  return out;
}

function planKey(ops) {
  return ops.map((op) => `${op.event} ${op.op} ${op.pos}`);
}

function comparePlans(a, b) {
  const ka = planKey(a);
  const kb = planKey(b);
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return ka.length - kb.length;
}

function computeRepairs(dfa, alphabet, events, K, maxPlans = 10) {
  const n = events.length;
  const S = dfa.states;
  const INF = Infinity;
  const dist = Array.from({ length: n + 1 }, () => new Array(S).fill(INF));
  dist[0][dfa.start] = 0;
  const deque = [[0, dfa.start]];
  while (deque.length) {
    const [pos, st] = deque.shift();
    const d = dist[pos][st];
    if (pos < n) {
      const t = dfa.trans[st].get(events[pos]);
      if (t !== undefined && dist[pos + 1][t] > d) {
        dist[pos + 1][t] = d;
        deque.unshift([pos + 1, t]);
      }
      if (dist[pos + 1][st] > d + 1) {
        dist[pos + 1][st] = d + 1;
        deque.push([pos + 1, st]);
      }
    }
    for (const a of alphabet) {
      const t = dfa.trans[st].get(a);
      if (t !== undefined && dist[pos][t] > d + 1) {
        dist[pos][t] = d + 1;
        deque.push([pos, t]);
      }
    }
  }
  let minCost = INF;
  for (const s of dfa.accept) minCost = Math.min(minCost, dist[n][s]);
  if (minCost === INF || minCost > K) {
    return {
      error: { code: 'NO_REPAIR_WITHIN_K', minCost: minCost === INF ? null : minCost, K },
      plans: [],
    };
  }

  const sortedAlphabet = [...alphabet].sort();
  const plans = [];
  const seen = new Set();
  function dfs(pos, st, ops) {
    if (plans.length >= HARD_CAP) return;
    if (pos === n && dfa.accept.has(st) && dist[pos][st] === minCost) {
      const key = JSON.stringify(planKey(ops));
      if (!seen.has(key)) {
        seen.add(key);
        plans.push(ops.slice());
      }
      return;
    }
    const d = dist[pos][st];
    if (pos < n) {
      const t = dfa.trans[st].get(events[pos]);
      if (t !== undefined && dist[pos + 1][t] === d) {
        dfs(pos + 1, t, ops);
      }
      if (dist[pos + 1][st] === d + 1) {
        ops.push({ op: 'delete', event: events[pos], pos });
        dfs(pos + 1, st, ops);
        ops.pop();
      }
    }
    for (const a of sortedAlphabet) {
      const t = dfa.trans[st].get(a);
      if (t !== undefined && dist[pos][t] === d + 1) {
        ops.push({ op: 'insert', event: a, pos });
        dfs(pos, t, ops);
        ops.pop();
      }
    }
  }
  dfs(0, dfa.start, []);

  plans.sort(comparePlans);
  const top = plans.slice(0, maxPlans);
  return {
    error: null,
    minCost,
    totalOptimal: plans.length,
    plans: top.map((ops) => ({ cost: minCost, ops, result: applyPlan(events, ops) })),
  };
}

module.exports = { computeRepairs, applyPlan };
