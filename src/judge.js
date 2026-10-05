'use strict';
// Judge: decides, per account, which operations are acceptable under a
// concurrent history.
//
// Model
// -----
// Each op declares `deps`: the opIds it happens-after. Per account this forms
// a causal DAG. A linearization is any topological order of that DAG; ops are
// evaluated greedily along a linearization (an op is accepted iff its
// constraints hold against the state built by previously accepted ops, else
// rejected with an error code and no effect).
//
// Because concurrent branches may admit several linearizations with different
// greedy outcomes, the judge computes the set of OPTIMAL outcomes: those
// maximizing, lexicographically,
//   1. total accepted freeze amount  (credit utilization)
//   2. total accepted release amount
//   3. number of accepted ops
// Outcomes tied on the full score vector ("同额并列最优") are ALL listed,
// sorted by a stable canonical signature. The search is an exact DFS over
// linearizations memoized on (processed-set, semantic state), so it agrees
// with brute-force enumeration (see src/brute.js) while scaling to histories
// whose causal width stays bounded (e.g. a few concurrent lanes per account).
//
// Error codes
// -----------
//  10 RELEASE_EXCEEDS_FROZEN  release amount exceeds the freeze's remaining
//  11 NEGATIVE_AVAILABLE      freeze would drive available credit negative
//  12 DUPLICATE_OP_ID         opId already appeared earlier in the log
//  13 DAILY_BUDGET_EXCEEDED   account daily freeze cap exceeded (no partial effect)
//  14 INVALID_DEPENDENCY      hold/release/unhold references a missing or
//                             rejected freeze, or exceeds the unreleased/held amount

const CODE = {
  RELEASE_EXCEEDS_FROZEN: 10,
  NEGATIVE_AVAILABLE: 11,
  DUPLICATE_OP_ID: 12,
  DAILY_BUDGET_EXCEEDED: 13,
  INVALID_DEPENDENCY: 14,
};

const MAX_OUTCOMES = 64; // safety cap on listed tied outcomes (sets `truncated`)

function scoreCompare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function cloneState(st) {
  return {
    available: st.available,
    budgets: new Map(st.budgets),
    freezes: new Map([...st.freezes].map(([k, v]) => [k, { ...v }])),
  };
}

// Applies one op to a CLONED state. Returns null on accept, or an error code.
function applyOp(op, dup, st, cfg) {
  if (dup) return CODE.DUPLICATE_OP_ID;
  switch (op.type) {
    case 'freeze': {
      const used = st.budgets.get(op.day) || 0;
      if (used + op.amount > cfg.dailyFreezeCap) return CODE.DAILY_BUDGET_EXCEEDED;
      if (op.amount > st.available) return CODE.NEGATIVE_AVAILABLE;
      st.available -= op.amount;
      st.budgets.set(op.day, used + op.amount);
      st.freezes.set(op.opId, { amount: op.amount, released: 0, held: 0 });
      return null;
    }
    case 'hold': {
      const f = st.freezes.get(op.freezeId);
      if (!f || f.amount - f.released - f.held < op.amount) return CODE.INVALID_DEPENDENCY;
      f.held += op.amount;
      return null;
    }
    case 'release': {
      const f = st.freezes.get(op.freezeId);
      if (!f) return CODE.INVALID_DEPENDENCY;
      if (op.amount > f.amount - f.released) return CODE.RELEASE_EXCEEDS_FROZEN;
      f.released += op.amount;
      st.available += op.amount;
      return null;
    }
    case 'unhold': {
      const f = st.freezes.get(op.freezeId);
      if (!f || op.amount > f.held) return CODE.INVALID_DEPENDENCY;
      f.held -= op.amount;
      return null;
    }
    default:
      throw new Error(`unknown op type: ${op.type}`);
  }
}

function contribution(op) {
  if (op.type === 'freeze') return [op.amount, 0, 1];
  if (op.type === 'release') return [0, op.amount, 1];
  return [0, 0, 1];
}

// Marks records whose opId already appeared earlier in the log (file order).
function toEntries(records) {
  const seen = new Set();
  return records.map((rec) => {
    const dup = seen.has(rec.opId);
    seen.add(rec.opId);
    return { rec, dup };
  });
}

// Resolves deps to predecessor bitmasks within one account's record list.
function buildGraph(entries) {
  const ops = entries.map((e) => e.rec);
  const firstIdx = new Map();
  ops.forEach((op, i) => {
    if (!firstIdx.has(op.opId)) firstIdx.set(op.opId, i);
  });
  const predMask = ops.map((op, i) => {
    let m = 0n;
    for (const d of op.deps || []) {
      const j = firstIdx.get(d);
      if (j === undefined) throw new Error(`op ${op.opId}: unknown same-account dep '${d}'`);
      if (j === i) throw new Error(`op ${op.opId}: self dependency`);
      m |= 1n << BigInt(j);
    }
    return m;
  });
  return { ops, predMask };
}

function signatureOf(arr) {
  return JSON.stringify([...arr].sort((x, y) => x[0] - y[0]));
}

// Builds the public outcome object from an array of [opIndex, codeOrNull]
// given in PROCESSING order (a witness linearization producing this outcome).
function finalizeOutcome(ops, cfg, arr) {
  const codeByIdx = new Map(arr);
  let score = [0, 0, 0];
  let available = cfg.creditLimit;
  const freezes = {};
  const verdicts = ops.map((op, i) => {
    const code = codeByIdx.get(i);
    const v = { opId: op.opId, status: code == null ? 'accepted' : 'rejected' };
    if (code != null) v.code = code;
    if (code == null) {
      const c = contribution(op);
      score = [score[0] + c[0], score[1] + c[1], score[2] + c[2]];
      if (op.type === 'freeze') {
        available -= op.amount;
        freezes[op.opId] = { amount: op.amount, released: 0, held: 0 };
      } else if (op.type === 'release') {
        available += op.amount;
        freezes[op.freezeId].released += op.amount;
      } else if (op.type === 'hold') {
        freezes[op.freezeId].held += op.amount;
      } else if (op.type === 'unhold') {
        freezes[op.freezeId].held -= op.amount;
      }
    }
    return v;
  });
  return { score, verdicts, available, freezes, order: arr.map(([i]) => i), signature: signatureOf(arr) };
}

function judgeAccount(entries, cfg) {
  const { ops, predMask } = buildGraph(entries);
  const n = ops.length;
  const FULL = (1n << BigInt(n)) - 1n;
  const memo = new Map();
  let truncated = false;

  const keyOf = (mask, st) => {
    const budgets = [...st.budgets.entries()].sort((a, b) => a[0] - b[0]).map(([d, u]) => `${d}:${u}`).join(',');
    const freezes = [...st.freezes.entries()].sort().map(([id, v]) => `${id}:${v.released}.${v.held}`).join(',');
    return `${mask.toString(36)}|${st.available}|${budgets}|${freezes}`;
  };

  // Returns { score, outcomes } where outcomes are distinct suffix verdict
  // arrays ([opIndex, codeOrNull]) achieving the optimal suffix score.
  function dfs(mask, st) {
    const k = keyOf(mask, st);
    const hit = memo.get(k);
    if (hit) return hit;
    let entry;
    if (mask === FULL) {
      entry = { score: [0, 0, 0], outcomes: [[]] };
    } else {
      let bestScore = null;
      let cand = [];
      for (let i = 0; i < n; i++) {
        const bit = 1n << BigInt(i);
        if (mask & bit) continue;
        if ((predMask[i] & ~mask) !== 0n) continue;
        const st2 = cloneState(st);
        const code = applyOp(ops[i], entries[i].dup, st2, cfg);
        const sub = dfs(mask | bit, st2);
        const c = code === null ? contribution(ops[i]) : [0, 0, 0];
        const total = [sub.score[0] + c[0], sub.score[1] + c[1], sub.score[2] + c[2]];
        const cmp = bestScore === null ? 1 : scoreCompare(total, bestScore);
        if (cmp > 0) {
          bestScore = total;
          cand = [{ idx: i, code, sub }];
        } else if (cmp === 0) {
          cand.push({ idx: i, code, sub });
        }
      }
      if (bestScore === null) throw new Error('dependency cycle detected in happens-before graph');
      const seen = new Set();
      const outcomes = [];
      for (const m of cand) {
        for (const suf of m.sub.outcomes) {
          const arr = [[m.idx, m.code], ...suf];
          const sig = signatureOf(arr);
          if (seen.has(sig)) continue;
          seen.add(sig);
          outcomes.push(arr);
          if (outcomes.length >= MAX_OUTCOMES) { truncated = true; break; }
        }
        if (truncated) break;
      }
      entry = { score: bestScore, outcomes };
    }
    memo.set(k, entry);
    return entry;
  }

  const init = { available: cfg.creditLimit, budgets: new Map(), freezes: new Map() };
  const root = dfs(0n, init);
  const outcomes = root.outcomes
    .map((arr) => finalizeOutcome(ops, cfg, arr))
    .sort((a, b) => (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0));
  return { available: outcomes[0].available, score: root.score, outcomes, truncated };
}

// Judges a whole history. `configs` maps account -> { creditLimit, dailyFreezeCap }.
function judge(records, configs) {
  const byAccount = new Map();
  const seen = new Set();
  for (const rec of records) {
    const dup = seen.has(rec.opId);
    seen.add(rec.opId);
    if (!byAccount.has(rec.account)) byAccount.set(rec.account, []);
    byAccount.get(rec.account).push({ rec, dup });
  }
  const accounts = {};
  for (const [name, entries] of byAccount) {
    const cfg = configs[name];
    if (!cfg) throw new Error(`no config for account '${name}'`);
    accounts[name] = judgeAccount(entries, cfg);
  }
  return { accounts };
}

module.exports = {
  CODE,
  MAX_OUTCOMES,
  judge,
  judgeAccount,
  toEntries,
  buildGraph,
  applyOp,
  cloneState,
  contribution,
  scoreCompare,
  finalizeOutcome,
};
