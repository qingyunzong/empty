'use strict';

const { FlowError } = require('./regex');
const { compileFlow } = require('./automata');

const MAX_LOG = 200;
const MAX_K = 6;
const MAX_PLANS = 10;
const DOMAIN_EVENTS = new Set(['申请', '复核', '放行', '入账', '冲正']);

// op rank used only to make enumeration order total; primary key is event name
const OP_RANK = { keep: 0, delete: 1, insert: 2 };

function zeroOneBfs(startIds, expand, size) {
  const INF = Infinity;
  const dist = new Array(size).fill(INF);
  const deque = [];
  for (const s of startIds) { dist[s] = 0; deque.push(s); }
  while (deque.length) {
    const u = deque.shift();
    for (const { v, cost } of expand(u)) {
      if (dist[u] + cost < dist[v]) {
        dist[v] = dist[u] + cost;
        if (cost === 0) deque.unshift(v); else deque.push(v);
      }
    }
  }
  return dist;
}

// Min edit distance repair over the (log position, dfa state) grid.
// Moves: keep (cost 0, consume matching event), delete (cost 1), insert (cost 1).
// Substitution is delete+insert (cost 2) by construction.
function computeRepairs(dfa, events, k) {
  const n = events.length;
  const S = dfa.trans.length;
  const id = (p, s) => p * S + s;
  const size = (n + 1) * S;

  // reverse transition lookup: rev[s] = [{ps, a}] with trans[ps][a] === s
  const rev = Array.from({ length: S }, () => []);
  for (let s = 0; s < S; s++) {
    for (const [a, t] of dfa.trans[s]) rev[t].push({ ps: s, a });
  }

  function moves(p, s) {
    const out = [];
    const row = dfa.trans[s];
    if (p < n) {
      const e = events[p];
      out.push({ op: 'delete', event: e, cost: 1, np: p + 1, ns: s });
      const t = row.get(e);
      if (t !== undefined) out.push({ op: 'keep', event: e, cost: 0, np: p + 1, ns: t });
    }
    for (const a of dfa.alphabet) {
      const t = row.get(a);
      if (t !== undefined) out.push({ op: 'insert', event: a, cost: 1, np: p, ns: t });
    }
    return out;
  }

  const dist = zeroOneBfs([id(0, dfa.start)], (u) => {
    const p = Math.floor(u / S); const s = u % S;
    return moves(p, s).map((m) => ({ v: id(m.np, m.ns), cost: m.cost }));
  }, size);

  const goalIds = [...dfa.finals].map((f) => id(n, f));
  const minCost = Math.min(...goalIds.map((g) => dist[g]));
  if (!Number.isFinite(minCost) || minCost > k) {
    return { minCost: Number.isFinite(minCost) ? minCost : null, plans: [] };
  }

  const rdist = zeroOneBfs(goalIds, (u) => {
    const p = Math.floor(u / S); const s = u % S;
    const out = [];
    if (p > 0) {
      out.push({ v: id(p - 1, s), cost: 1 }); // inverse of delete
      for (const { ps, a } of rev[s]) {
        if (a === events[p - 1]) out.push({ v: id(p - 1, ps), cost: 0 }); // inverse of keep
      }
    }
    for (const { ps } of rev[s]) out.push({ v: id(p, ps), cost: 1 }); // inverse of insert
    return out;
  }, size);

  // enumerate all shortest edit scripts in lexicographic order of
  // (event name, op) labels, capped at MAX_PLANS
  const plans = [];
  const seen = new Set();

  function dfs(p, s, ops) {
    if (plans.length >= MAX_PLANS) return;
    if (p === n && dfa.finals.has(s)) {
      const sig = JSON.stringify(ops);
      if (!seen.has(sig)) { seen.add(sig); plans.push(ops.slice()); }
      return;
    }
    const ms = moves(p, s)
      .filter((m) => dist[id(p, s)] + m.cost + rdist[id(m.np, m.ns)] === minCost)
      .sort((x, y) => {
        if (x.event !== y.event) return x.event < y.event ? -1 : 1;
        return OP_RANK[x.op] - OP_RANK[y.op];
      });
    for (const m of ms) {
      if (m.op !== 'keep') ops.push({ op: m.op, event: m.event, at: m.np === p ? p : p });
      dfs(m.np, m.ns, ops);
      if (m.op !== 'keep') ops.pop();
      if (plans.length >= MAX_PLANS) return;
    }
  }
  dfs(0, dfa.start, []);
  return { minCost, plans };
}

function checkFlow(flowSrc, events, k = MAX_K) {
  if (k > MAX_K) throw new FlowError('K_TOO_LARGE', `K must be <= ${MAX_K}`);
  const { dfa, alphabet } = compileFlow(flowSrc);
  if (events.length > MAX_LOG) {
    throw new FlowError('LOG_TOO_LONG', `log has ${events.length} events, max ${MAX_LOG}`);
  }

  // domain semantics: unknown event / reversal without an unmatched posting
  let semantic = null;
  let posted = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!DOMAIN_EVENTS.has(e)) { semantic = { reason: 'UNKNOWN_EVENT', at: i, event: e }; break; }
    if (e === '入账') posted++;
    else if (e === '冲正') {
      if (posted === 0) { semantic = { reason: 'REVERSAL_WITHOUT_POSTING', at: i, event: e }; break; }
      posted--;
    }
  }

  // DFA run: the deterministic state path is the shortest-path witness
  const states = [dfa.start];
  let cur = dfa.start;
  let failedAt = null;
  for (let i = 0; i < events.length; i++) {
    const t = dfa.trans[cur].get(events[i]);
    if (t === undefined) { failedAt = i; break; }
    cur = t;
    states.push(cur);
  }
  const dfaAccept = failedAt === null && dfa.finals.has(cur);
  const accept = dfaAccept && semantic === null;

  const witness = { states, events: events.slice(0, states.length - 1) };
  if (failedAt !== null) { witness.failedAt = failedAt; witness.event = events[failedAt]; }

  const result = { accept, witness, repairs: [] };
  if (semantic) result.reason = semantic;
  if (!accept) {
    const { minCost, plans } = computeRepairs(dfa, events, k);
    if (minCost === null || minCost > k) {
      result.error = 'NO_REPAIR_WITHIN_K';
      result.minCost = minCost;
    } else {
      result.minCost = minCost;
      result.repairs = plans;
    }
  }
  return result;
}

module.exports = { checkFlow, computeRepairs, MAX_LOG, MAX_K, MAX_PLANS, DOMAIN_EVENTS };
