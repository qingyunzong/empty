'use strict';

const { AccountState, ERR_DUPLICATE_OPID, ERR_CAUSAL_CYCLE, CODE_NAMES } = require('./sim');

function cmpOps(a, b) {
  const ta = a.ts == null ? 0 : a.ts;
  const tb = b.ts == null ? 0 : b.ts;
  if (ta !== tb) return ta - tb;
  return a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
}

function cmpSeq(sa, sb) {
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
  }
  return sa.length - sb.length;
}

/**
 * Build the per-account happens-before poset from `causes` edges
 * (only same-account edges constrain the per-account merge order).
 */
function buildPoset(ops) {
  const ids = new Set(ops.map((o) => o.opId));
  const indeg = new Map();
  const adj = new Map();
  for (const o of ops) {
    indeg.set(o.opId, 0);
    adj.set(o.opId, []);
  }
  for (const o of ops) {
    const seen = new Set();
    for (const c of o.causes || []) {
      if (ids.has(c) && c !== o.opId && !seen.has(c)) {
        seen.add(c);
        adj.get(c).push(o.opId);
        indeg.set(o.opId, indeg.get(o.opId) + 1);
      }
    }
  }
  return { ids, indeg, adj };
}

/**
 * Canonical merge of concurrent branches: Kahn topological sort, breaking
 * ties among ready ops by (ts, opId). This is the deterministic
 * happens-before merge; its simulation result defines the optimum
 * (first-come-first-served priority). Returns the order plus any ops
 * trapped in causality cycles.
 */
function canonicalOrder(ops, poset) {
  const byId = new Map(ops.map((o) => [o.opId, o]));
  const indeg = new Map(poset.indeg);
  const ready = [];
  for (const o of ops) if (indeg.get(o.opId) === 0) ready.push(o.opId);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => cmpOps(byId.get(a), byId.get(b)));
    const id = ready.shift();
    order.push(id);
    for (const nxt of poset.adj.get(id)) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) ready.push(nxt);
    }
  }
  const inOrder = new Set(order);
  const cyclic = ops.filter((o) => !inOrder.has(o.opId)).map((o) => o.opId);
  return { order, cyclic };
}

/**
 * Enumerate all linearizations whose per-op verdicts are identical to the
 * canonical (optimal) ones — the "tied optima". Concurrent equal-amount ops
 * whose relative order changes nothing therefore all appear. DFS prunes any
 * prefix whose verdict already differs from canonical, which is exact: a
 * divergent verdict can never be repaired by later ops.
 */
function enumerateTiedOptima(ops, poset, config, canonicalVerdicts, canonicalSeq, opts) {
  const maxTies = opts.maxTies == null ? 1000 : opts.maxTies;
  const maxNodes = opts.maxNodes == null ? 200000 : opts.maxNodes;
  const byId = new Map(ops.map((o) => [o.opId, o]));
  const total = canonicalSeq.length;
  const sequences = [];
  let visited = 0;
  let truncated = false;

  const indeg = new Map(poset.indeg);
  const initialReady = [];
  for (const id of canonicalSeq) if (indeg.get(id) === 0) initialReady.push(id);

  function dfs(ready, state, prefix) {
    if (truncated) return;
    if (++visited > maxNodes) {
      truncated = true;
      return;
    }
    if (prefix.length === total) {
      if (sequences.length >= maxTies) {
        truncated = true;
        return;
      }
      sequences.push(prefix.slice());
      return;
    }
    const sorted = ready.slice().sort((a, b) => cmpOps(byId.get(a), byId.get(b)));
    for (const id of sorted) {
      const nextState = state.clone();
      const code = nextState.apply(byId.get(id));
      if (code !== canonicalVerdicts.get(id)) continue; // prune: not a tied optimum
      const promoted = [];
      for (const nxt of poset.adj.get(id)) {
        indeg.set(nxt, indeg.get(nxt) - 1);
        if (indeg.get(nxt) === 0) {
          promoted.push(nxt);
          ready.push(nxt);
        }
      }
      const idx = ready.indexOf(id);
      ready.splice(idx, 1);
      prefix.push(id);
      dfs(ready, nextState, prefix);
      prefix.pop();
      for (const nxt of promoted) ready.splice(ready.indexOf(nxt), 1);
      ready.splice(idx, 0, id);
      for (const nxt of poset.adj.get(id)) indeg.set(nxt, indeg.get(nxt) + 1);
      if (truncated) return;
    }
  }

  dfs(initialReady, new AccountState(config), []);
  sequences.sort(cmpSeq); // stable, deterministic output order
  return { count: sequences.length, truncated, sequences };
}

/** Judge one account's ops (already deduplicated). */
function judgeAccount(ops, config, opts = {}) {
  const poset = buildPoset(ops);
  const { order, cyclic } = canonicalOrder(ops, poset);
  const byId = new Map(ops.map((o) => [o.opId, o]));

  const state = new AccountState(config);
  const verdicts = new Map();
  for (const id of order) verdicts.set(id, state.apply(byId.get(id)));
  for (const id of cyclic) verdicts.set(id, ERR_CAUSAL_CYCLE);

  const tiedOptimal =
    opts.maxTies === 0
      ? { count: 0, truncated: false, sequences: [] }
      : enumerateTiedOptima(ops, poset, config, verdicts, order, opts);

  const verdictList = ops.map((o) => ({
    opId: o.opId,
    type: o.type,
    code: verdicts.get(o.opId),
    status: verdicts.get(o.opId) === 0 ? 'accepted' : 'rejected',
    reason: CODE_NAMES[verdicts.get(o.opId)],
  }));

  const dailyFrozen = {};
  for (const [day, amt] of state.dailyFrozen) dailyFrozen[day] = amt;
  const freezes = {};
  for (const [id, f] of state.freezes) freezes[id] = { ...f };

  const num = (x) => (x === Infinity ? null : x); // null == unlimited in JSON output
  return {
    available: num(state.available),
    limit: num(state.limit),
    dailyFreezeCap: num(state.dailyFreezeCap),
    frozenTotal: state.frozenTotal,
    dailyFrozen,
    freezes,
    sequence: order,
    cyclic,
    verdicts: verdictList,
    tiedOptimal,
  };
}

/**
 * Judge a whole history (array of ops). Duplicate opIds: first occurrence
 * competes normally, later occurrences are rejected with code 12.
 */
function judge(ops, config = {}, opts = {}) {
  const seen = new Set();
  const first = [];
  const duplicates = [];
  for (const op of ops) {
    if (seen.has(op.opId)) duplicates.push(op);
    else {
      seen.add(op.opId);
      first.push(op);
    }
  }

  const byAccount = new Map();
  for (const op of first) {
    if (!byAccount.has(op.account)) byAccount.set(op.account, []);
    byAccount.get(op.account).push(op);
  }

  const accounts = {};
  for (const [acc, accOps] of byAccount) {
    const cfg = resolveConfig(config, acc);
    accounts[acc] = judgeAccount(accOps, cfg, opts);
  }

  for (const dup of duplicates) {
    const acc = dup.account;
    if (!accounts[acc]) {
      accounts[acc] = judgeAccount([], resolveConfig(config, acc), opts);
    }
    accounts[acc].verdicts.push({
      opId: dup.opId,
      type: dup.type,
      code: ERR_DUPLICATE_OPID,
      status: 'rejected',
      reason: CODE_NAMES[ERR_DUPLICATE_OPID],
    });
  }

  return { accounts };
}

function resolveConfig(config, account) {
  const def = config.default || {};
  const per = (config.accounts && config.accounts[account]) || {};
  return { ...def, ...per };
}

module.exports = { judge, judgeAccount, canonicalOrder, buildPoset, enumerateTiedOptima, cmpSeq, cmpOps, resolveConfig };
