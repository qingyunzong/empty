// Exhaustive enumerator used as an independent oracle for small instances
// (total orders <= 8, quantities <= 3 per the acceptance criteria).

import { cmp, add, mul, frac, ZERO } from './fraction.js';

export function enumerateAll(orders, fundsByAccount) {
  const n = orders.length;
  const symbols = [...new Set(orders.map((o) => o.symbol))];
  const accounts = [...new Set(orders.filter((o) => o.side === 'buy').map((o) => o.account))];
  const funds = accounts.map((a) => fundsByAccount.get(a) ?? ZERO);
  const assign = new Array(n).fill(0n);
  let bestQty = null;
  let bestSpend = null;
  let count = 0n;
  let vector = null;

  function evaluate() {
    const buySum = new Map(symbols.map((s) => [s, 0n]));
    const sellSum = new Map(symbols.map((s) => [s, 0n]));
    const spend = accounts.map(() => ({ num: 0n, den: 1n }));
    let spendTotal = { num: 0n, den: 1n };
    for (let i = 0; i < n; i++) {
      const o = orders[i];
      if (o.side === 'buy') {
        buySum.set(o.symbol, buySum.get(o.symbol) + assign[i]);
        const d = mul(o.price, frac(assign[i]));
        const ai = accounts.indexOf(o.account);
        spend[ai] = add(spend[ai], d);
        spendTotal = add(spendTotal, d);
      } else {
        sellSum.set(o.symbol, sellSum.get(o.symbol) + assign[i]);
      }
    }
    for (const s of symbols) {
      if (buySum.get(s) !== sellSum.get(s)) return;
    }
    for (let a = 0; a < accounts.length; a++) {
      if (cmp(spend[a], funds[a]) > 0) return;
    }
    let q = 0n;
    for (const s of symbols) q += buySum.get(s);
    const better =
      bestQty === null || q > bestQty || (q === bestQty && cmp(spendTotal, bestSpend) < 0);
    if (better) {
      bestQty = q;
      bestSpend = spendTotal;
      count = 1n;
      vector = [...assign];
    } else if (q === bestQty && cmp(spendTotal, bestSpend) === 0) {
      count += 1n;
      for (let i = 0; i < n; i++) {
        if (assign[i] < vector[i]) { vector = [...assign]; break; }
        if (assign[i] > vector[i]) break;
      }
    }
  }

  function rec(i) {
    if (i === n) {
      evaluate();
      return;
    }
    for (let v = 0n; v <= orders[i].cap; v++) {
      assign[i] = v;
      rec(i + 1);
    }
    assign[i] = 0n;
  }
  rec(0);
  return { qty: bestQty, spend: bestSpend, count, vector };
}
