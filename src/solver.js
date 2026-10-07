// Clearing solver: constraint propagation + branch search with a proof tree.
//
// Objectives (lexicographic):
//   1. maximize total traded volume (sum over instruments of matched quantity)
//   2. minimize total buyer spend
//   3. among ties, the fill vector ordered by ascending order id is
//      lexicographically minimal; the exact number of tied optimal vectors
//      is reported as a BigInt.
//
// The proof tree records, for every node, the propagated bounds, the
// remaining-volume upper bound, the spend lower bound, and for leaves the
// prune reason or the solution. An independent checker (checker.js) replays
// the tree and validates every split coverage and the optimal count.

import { frac, add, sub, mul, div, cmp, eq, floorFrac, ZERO } from './fraction.js';

export class BudgetExhausted extends Error {
  constructor(nodes) {
    super('E_BUDGET');
    this.code = 'E_BUDGET';
    this.nodes = nodes;
  }
}

export function compareIds(a, b) {
  const sa = String(a);
  const sb = String(b);
  const na = /^-?\d+$/.test(sa) ? BigInt(sa) : null;
  const nb = /^-?\d+$/.test(sb) ? BigInt(sb) : null;
  if (na !== null && nb !== null) return na < nb ? -1 : na > nb ? 1 : 0;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

// Build the internal solving context from a problem:
// { orders: [{id, account, side, instrument, qty, limit}],
//   prices: {instrument: frac}, funds: {account: frac} }
export function buildContext(problem) {
  const vars = [];
  for (const o of problem.orders) {
    const price = problem.prices[o.instrument];
    if (price === undefined) continue;
    if (o.qty === 0n) continue;
    const participates =
      o.side === 'buy' ? cmp(o.limit, price) >= 0 : cmp(o.limit, price) <= 0;
    if (!participates) continue;
    vars.push({
      id: String(o.id),
      account: o.account,
      side: o.side,
      instrument: o.instrument,
      qty: o.qty,
      price,
    });
  }
  vars.sort((x, y) => compareIds(x.id, y.id));

  const instMap = new Map();
  const accMap = new Map();
  vars.forEach((v, j) => {
    if (!instMap.has(v.instrument)) instMap.set(v.instrument, { buys: [], sells: [] });
    const inst = instMap.get(v.instrument);
    if (v.side === 'buy') {
      inst.buys.push(j);
      if (!accMap.has(v.account)) {
        const funds = problem.funds[v.account];
        accMap.set(v.account, { vars: [], funds: funds === undefined ? ZERO : funds });
      }
      accMap.get(v.account).vars.push(j);
    } else {
      inst.sells.push(j);
    }
  });

  return {
    n: vars.length,
    vars,
    instruments: [...instMap.values()],
    accounts: [...accMap.values()],
  };
}

// Constraint propagation over lo/hi arrays (mutated in place).
// Returns { ok:false, reason } or { ok:true, volumeUB, spendLB }.
export function propagate(ctx, lo, hi) {
  for (;;) {
    let changed = false;
    for (const inst of ctx.instruments) {
      let sbl = 0n;
      let sbh = 0n;
      let ssl = 0n;
      let ssh = 0n;
      for (const j of inst.buys) {
        sbl += lo[j];
        sbh += hi[j];
      }
      for (const j of inst.sells) {
        ssl += lo[j];
        ssh += hi[j];
      }
      if (sbl > ssh || ssl > sbh) return { ok: false, reason: 'flow_infeasible' };
      const maxV = sbh < ssh ? sbh : ssh;
      const minV = sbl > ssl ? sbl : ssl;
      for (const j of inst.buys) {
        let bound = maxV - (sbl - lo[j]);
        if (bound < hi[j]) {
          hi[j] = bound;
          changed = true;
        }
        bound = minV - (sbh - hi[j]);
        if (bound > lo[j]) {
          lo[j] = bound;
          changed = true;
        }
        if (lo[j] > hi[j]) return { ok: false, reason: 'flow_infeasible' };
      }
      for (const j of inst.sells) {
        let bound = maxV - (ssl - lo[j]);
        if (bound < hi[j]) {
          hi[j] = bound;
          changed = true;
        }
        bound = minV - (ssh - hi[j]);
        if (bound > lo[j]) {
          lo[j] = bound;
          changed = true;
        }
        if (lo[j] > hi[j]) return { ok: false, reason: 'flow_infeasible' };
      }
    }
    for (const acc of ctx.accounts) {
      let minSpend = ZERO;
      for (const j of acc.vars) minSpend = add(minSpend, mul(ctx.vars[j].price, frac(lo[j])));
      if (cmp(minSpend, acc.funds) > 0) return { ok: false, reason: 'funds_infeasible' };
      for (const j of acc.vars) {
        const p = ctx.vars[j].price;
        if (p.num === 0n) continue;
        const headroom = sub(acc.funds, minSpend);
        const extra = floorFrac(div(headroom, p));
        const bound = lo[j] + extra;
        if (bound < hi[j]) {
          hi[j] = bound;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  let volumeUB = 0n;
  for (const inst of ctx.instruments) {
    let sbh = 0n;
    let ssh = 0n;
    for (const j of inst.buys) sbh += hi[j];
    for (const j of inst.sells) ssh += hi[j];
    volumeUB += sbh < ssh ? sbh : ssh;
  }
  let spendLB = ZERO;
  for (let j = 0; j < ctx.n; j++) {
    if (ctx.vars[j].side === 'buy') {
      spendLB = add(spendLB, mul(ctx.vars[j].price, frac(lo[j])));
    }
  }
  return { ok: true, volumeUB, spendLB };
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

export function solve(problem, { budget = 100000, proof = true } = {}) {
  const ctx = buildContext(problem);
  const n = ctx.n;
  const lo0 = new Array(n).fill(0n);
  const hi0 = ctx.vars.map((v) => v.qty);

  let best = null; // {volume, spend}
  let count = 0n;
  let lexMin = null;
  let nodes = 0;
  let nextId = 0;

  function search(lo, hi, node) {
    nodes += 1;
    if (nodes > budget) throw new BudgetExhausted(nodes);
    const res = propagate(ctx, lo, hi);
    if (proof) {
      node.id = nextId++;
      node.bounds = { lo: lo.slice(), hi: hi.slice() };
    }
    if (!res.ok) {
      if (proof) {
        node.leaf = 'pruned';
        node.reason = res.reason;
      }
      return;
    }
    if (proof) {
      node.volumeUB = res.volumeUB;
      node.spendLB = res.spendLB;
    }
    if (best && res.volumeUB < best.volume) {
      if (proof) {
        node.leaf = 'pruned';
        node.reason = 'volume_bound';
      }
      return;
    }
    if (best && res.volumeUB === best.volume && cmp(res.spendLB, best.spend) > 0) {
      if (proof) {
        node.leaf = 'pruned';
        node.reason = 'spend_bound';
      }
      return;
    }
    let fixed = 0;
    for (let j = 0; j < n; j++) if (lo[j] === hi[j]) fixed += 1;
    if (fixed === n) {
      let volume = 0n;
      let spend = ZERO;
      for (let j = 0; j < n; j++) {
        if (ctx.vars[j].side === 'buy') {
          volume += lo[j];
          spend = add(spend, mul(ctx.vars[j].price, frac(lo[j])));
        }
      }
      const vector = lo.slice();
      if (proof) {
        node.leaf = 'solution';
        node.vector = vector;
        node.volume = volume;
        node.spend = spend;
      }
      if (!best || volume > best.volume || (volume === best.volume && cmp(spend, best.spend) < 0)) {
        best = { volume, spend };
        count = 1n;
        lexMin = vector;
      } else if (volume === best.volume && cmp(spend, best.spend) === 0) {
        count += 1n;
        if (lexLess(vector, lexMin)) lexMin = vector;
      }
      return;
    }
    let split = 0;
    while (lo[split] === hi[split]) split += 1;
    if (proof) {
      node.split = ctx.vars[split].id;
      node.children = [];
    }
    for (let v = lo[split]; v <= hi[split]; v++) {
      const clo = lo.slice();
      const chi = hi.slice();
      clo[split] = v;
      chi[split] = v;
      const child = proof ? { fix: { var: ctx.vars[split].id, value: v } } : null;
      search(clo, chi, child);
      if (proof) node.children.push(child);
    }
  }

  const root = proof ? {} : null;
  try {
    search(lo0, hi0, root);
  } catch (e) {
    if (e instanceof BudgetExhausted) {
      // Never report an exhausted search as a (zero-fill) result.
      return { status: 'E_BUDGET', nodes };
    }
    throw e;
  }

  const vector = {};
  for (const o of problem.orders) vector[String(o.id)] = 0n;
  if (lexMin) {
    for (let j = 0; j < n; j++) vector[ctx.vars[j].id] = lexMin[j];
  }

  return {
    status: 'OK',
    volume: best ? best.volume : 0n,
    spend: best ? best.spend : ZERO,
    count,
    vector,
    participating: ctx.vars.map((v) => v.id),
    proof: root,
    stats: { nodes },
  };
}
