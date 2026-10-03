// Clearing solver: constraint propagation + depth-first branch search.
//
// Input orders are the eligible orders of one window, sorted by ascending id:
//   { id, account, side: 'buy'|'sell', symbol, cap: BigInt, price: {num, den} }
// fundsByAccount: Map account -> normalized fraction of available funds.
//
// Objectives (lexicographic):
//   1. maximize total matched quantity Q = sum of per-symbol matched volume
//   2. minimize total buyer spend S = sum(price * fill) over buy orders
//   3. among ties of (1),(2): lexicographically smallest fill vector
//      (integer quantities ordered by ascending order id)
// Also reports the exact count (BigInt) of all vectors tied under (1) and (2).
//
// The proof tree records, per node, the remaining fill upper bound (ubQ),
// the spend lower bound (lbSpend) and the pruning reason
// ('balance' | 'funds' | 'bound-q' | 'bound-spend'), so an independent
// checker can verify split coverage and the optimal count.
// If the node budget is exhausted the search throws E_BUDGET instead of
// silently reporting a (possibly zero-fill) result.

import { cmp, add, sub, mul, frac, ZERO } from './fraction.js';

export class BudgetExceeded extends Error {
  constructor() {
    super('search budget exhausted');
    this.code = 'E_BUDGET';
  }
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

export function solveProblem(orders, fundsByAccount, budget = 1_000_000) {
  const n = orders.length;
  const symbols = [...new Set(orders.map((o) => o.symbol))];
  const symIdx = new Map(symbols.map((s, i) => [s, i]));
  const accounts = [...new Set(orders.filter((o) => o.side === 'buy').map((o) => o.account))];
  const accIdx = new Map(accounts.map((a, i) => [a, i]));
  const funds = accounts.map((a) => fundsByAccount.get(a) ?? ZERO);

  const S = symbols.length;
  const buySum = new Array(S).fill(0n);
  const sellSum = new Array(S).fill(0n);
  const remBuy = new Array(S).fill(0n);
  const remSell = new Array(S).fill(0n);
  for (const o of orders) {
    const si = symIdx.get(o.symbol);
    if (o.side === 'buy') remBuy[si] += o.cap;
    else remSell[si] += o.cap;
  }
  const spend = accounts.map(() => ({ num: 0n, den: 1n }));
  let spendTotal = { num: 0n, den: 1n };

  // Suffix sums of price*cap over negative-priced remaining buys (for lbSpend).
  const negSuffix = new Array(n + 1);
  negSuffix[n] = { num: 0n, den: 1n };
  for (let i = n - 1; i >= 0; i--) {
    negSuffix[i] = negSuffix[i + 1];
    const o = orders[i];
    if (o.side === 'buy' && cmp(o.price, ZERO) < 0) {
      negSuffix[i] = add(negSuffix[i], mul(o.price, frac(o.cap)));
    }
  }
  // Per account: indices of negative-priced buys (for the funds prune rule).
  const negBuyIdx = new Map();
  orders.forEach((o, i) => {
    if (o.side === 'buy' && cmp(o.price, ZERO) < 0) {
      const k = accIdx.get(o.account);
      if (!negBuyIdx.has(k)) negBuyIdx.set(k, []);
      negBuyIdx.get(k).push(i);
    }
  });

  const assign = new Array(n).fill(0n);
  let nodes = 0;
  const best = { qty: null, spend: null, count: 0n, vector: null };

  const ubQ = () => {
    let ub = 0n;
    for (let s = 0; s < S; s++) {
      const b = buySum[s] + remBuy[s];
      const e = sellSum[s] + remSell[s];
      ub += b < e ? b : e;
    }
    return ub;
  };

  const balanceInfeasibleSymbol = () => {
    for (let s = 0; s < S; s++) {
      if (buySum[s] > sellSum[s] + remSell[s]) return symbols[s];
      if (sellSum[s] > buySum[s] + remBuy[s]) return symbols[s];
    }
    return null;
  };

  const fundsViolatedAccount = (depth) => {
    for (let a = 0; a < accounts.length; a++) {
      if (cmp(spend[a], funds[a]) > 0) {
        const neg = negBuyIdx.get(a) ?? [];
        if (!neg.some((i) => i >= depth)) return accounts[a];
      }
    }
    return null;
  };

  function dfs(depth) {
    if (++nodes > budget) throw new BudgetExceeded();
    const node = {
      depth,
      var: depth < n ? orders[depth].id : null,
      ubQ: null,
      lbSpend: null,
      prune: null,
      leaf: null,
      children: [],
    };
    const badSym = balanceInfeasibleSymbol();
    if (badSym !== null) {
      node.prune = { reason: 'balance', symbol: badSym };
      return node;
    }
    const badAcc = fundsViolatedAccount(depth);
    if (badAcc !== null) {
      node.prune = { reason: 'funds', account: badAcc };
      return node;
    }
    const ub = ubQ();
    const lb = add(spendTotal, negSuffix[depth]);
    node.ubQ = ub;
    node.lbSpend = lb;
    if (best.qty !== null) {
      if (ub < best.qty) {
        node.prune = { reason: 'bound-q' };
        return node;
      }
      if (ub === best.qty && cmp(lb, best.spend) > 0) {
        node.prune = { reason: 'bound-spend' };
        return node;
      }
    }
    if (depth === n) {
      let feasible = true;
      for (let s = 0; s < S; s++) if (buySum[s] !== sellSum[s]) feasible = false;
      for (let a = 0; a < accounts.length; a++) {
        if (cmp(spend[a], funds[a]) > 0) feasible = false;
      }
      let q = 0n;
      for (let s = 0; s < S; s++) q += buySum[s];
      node.leaf = {
        feasible,
        qty: feasible ? q : null,
        spend: feasible ? { ...spendTotal } : null,
      };
      if (feasible) {
        const better =
          best.qty === null || q > best.qty || (q === best.qty && cmp(spendTotal, best.spend) < 0);
        if (better) {
          best.qty = q;
          best.spend = { ...spendTotal };
          best.count = 1n;
          best.vector = [...assign];
        } else if (q === best.qty && cmp(spendTotal, best.spend) === 0) {
          best.count += 1n;
          if (lexLess(assign, best.vector)) best.vector = [...assign];
        }
      }
      return node;
    }
    const o = orders[depth];
    const si = symIdx.get(o.symbol);
    const ai = o.side === 'buy' ? accIdx.get(o.account) : -1;
    if (o.side === 'buy') remBuy[si] -= o.cap;
    else remSell[si] -= o.cap;
    for (let v = 0n; v <= o.cap; v++) {
      assign[depth] = v;
      let delta = null;
      if (o.side === 'buy') {
        buySum[si] += v;
        delta = mul(o.price, frac(v));
        spend[ai] = add(spend[ai], delta);
        spendTotal = add(spendTotal, delta);
      } else {
        sellSum[si] += v;
      }
      node.children.push({ value: v, node: dfs(depth + 1) });
      if (o.side === 'buy') {
        buySum[si] -= v;
        spend[ai] = sub(spend[ai], delta);
        spendTotal = sub(spendTotal, delta);
      } else {
        sellSum[si] -= v;
      }
    }
    assign[depth] = 0n;
    if (o.side === 'buy') remBuy[si] += o.cap;
    else remSell[si] += o.cap;
    return node;
  }

  const proof = dfs(0);
  return {
    qty: best.qty,
    spend: best.spend,
    count: best.count,
    vector: best.vector,
    proof,
    nodes,
  };
}
