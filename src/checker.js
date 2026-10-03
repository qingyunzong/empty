// Independent proof checker. Re-derives every bound from the partial
// assignment, verifies that each branch node covers its whole domain exactly
// once, validates every pruning reason, recomputes the optimum and the tie
// count from the surviving leaves, and compares them against the reported
// result. A tampered count/vector/qty or an invalid prune is rejected.

import { cmp, add, mul, frac, ZERO } from './fraction.js';

const B = (v) => BigInt(v);
const F = (f) => frac(B(f.num), B(f.den));

export function verifyProof(orders, fundsByAccount, proof, reported) {
  const errors = [];
  const n = orders.length;
  const symbols = [...new Set(orders.map((o) => o.symbol))];
  const accounts = [...new Set(orders.filter((o) => o.side === 'buy').map((o) => o.account))];
  const funds = accounts.map((a) => fundsByAccount.get(a) ?? ZERO);
  const assign = new Array(n).fill(0n);
  const leaves = [];
  const boundPrunes = [];

  function stateAt(depth) {
    const buySum = new Map(symbols.map((s) => [s, 0n]));
    const sellSum = new Map(symbols.map((s) => [s, 0n]));
    const remBuy = new Map(symbols.map((s) => [s, 0n]));
    const remSell = new Map(symbols.map((s) => [s, 0n]));
    const spend = accounts.map(() => ({ num: 0n, den: 1n }));
    let spendTotal = { num: 0n, den: 1n };
    for (let i = 0; i < n; i++) {
      const o = orders[i];
      if (i < depth) {
        const v = assign[i];
        if (o.side === 'buy') {
          buySum.set(o.symbol, buySum.get(o.symbol) + v);
          const d = mul(o.price, frac(v));
          const ai = accounts.indexOf(o.account);
          spend[ai] = add(spend[ai], d);
          spendTotal = add(spendTotal, d);
        } else {
          sellSum.set(o.symbol, sellSum.get(o.symbol) + v);
        }
      } else if (o.side === 'buy') {
        remBuy.set(o.symbol, remBuy.get(o.symbol) + o.cap);
      } else {
        remSell.set(o.symbol, remSell.get(o.symbol) + o.cap);
      }
    }
    return { buySum, sellSum, remBuy, remSell, spend, spendTotal };
  }

  function ubOf(st) {
    let ub = 0n;
    for (const s of symbols) {
      const b = st.buySum.get(s) + st.remBuy.get(s);
      const e = st.sellSum.get(s) + st.remSell.get(s);
      ub += b < e ? b : e;
    }
    return ub;
  }

  function lbOf(st, depth) {
    let lb = st.spendTotal;
    for (let i = depth; i < n; i++) {
      const o = orders[i];
      if (o.side === 'buy' && cmp(o.price, ZERO) < 0) {
        lb = add(lb, mul(o.price, frac(o.cap)));
      }
    }
    return lb;
  }

  function walk(node, depth) {
    const expectedVar = depth < n ? orders[depth].id : null;
    if (node.var !== expectedVar) {
      errors.push(`depth ${depth}: var mismatch ${node.var} != ${expectedVar}`);
      return;
    }
    const st = stateAt(depth);
    const ub = ubOf(st);
    const lb = lbOf(st, depth);
    if (node.prune) {
      const r = node.prune.reason;
      if (node.children && node.children.length > 0) {
        errors.push(`depth ${depth}: pruned node has children`);
      }
      if (r === 'balance') {
        const bad = symbols.some(
          (s) =>
            st.buySum.get(s) > st.sellSum.get(s) + st.remSell.get(s) ||
            st.sellSum.get(s) > st.buySum.get(s) + st.remBuy.get(s),
        );
        if (!bad) errors.push(`depth ${depth}: invalid 'balance' prune`);
      } else if (r === 'funds') {
        const bad = accounts.some((a, ai) => {
          if (cmp(st.spend[ai], funds[ai]) <= 0) return false;
          for (let i = depth; i < n; i++) {
            const o = orders[i];
            if (o.side === 'buy' && o.account === a && cmp(o.price, ZERO) < 0) return false;
          }
          return true;
        });
        if (!bad) errors.push(`depth ${depth}: invalid 'funds' prune`);
      } else if (r === 'bound-q' || r === 'bound-spend') {
        boundPrunes.push({ reason: r, ub, lb, depth });
      } else {
        errors.push(`depth ${depth}: unknown prune reason '${r}'`);
      }
      return;
    }
    // Non-pruned node: recorded bounds must match recomputed bounds.
    if (node.ubQ === null || B(node.ubQ) !== ub) {
      errors.push(`depth ${depth}: ubQ mismatch ${node.ubQ} != ${ub}`);
    }
    if (!node.lbSpend || B(node.lbSpend.num) !== lb.num || B(node.lbSpend.den) !== lb.den) {
      errors.push(`depth ${depth}: lbSpend mismatch`);
    }
    if (depth === n) {
      if (!node.leaf) {
        errors.push(`depth ${depth}: missing leaf record`);
        return;
      }
      let feasible = true;
      for (const s of symbols) {
        if (st.buySum.get(s) !== st.sellSum.get(s)) feasible = false;
      }
      for (let a = 0; a < accounts.length; a++) {
        if (cmp(st.spend[a], funds[a]) > 0) feasible = false;
      }
      let q = 0n;
      for (const s of symbols) q += st.buySum.get(s);
      if (node.leaf.feasible !== feasible) {
        errors.push(`depth ${depth}: leaf feasibility mismatch`);
      }
      if (feasible) {
        if (node.leaf.qty === null || B(node.leaf.qty) !== q) {
          errors.push(`depth ${depth}: leaf qty mismatch`);
        }
        leaves.push({ assign: [...assign], qty: q, spend: st.spendTotal });
      }
      return;
    }
    // Branch node: children must cover [0..cap] exactly once, in order.
    const cap = orders[depth].cap;
    const kids = node.children ?? [];
    if (BigInt(kids.length) !== cap + 1n) {
      errors.push(`depth ${depth}: split does not cover domain [0..${cap}]`);
      return;
    }
    for (let i = 0; i < kids.length; i++) {
      if (B(kids[i].value) !== BigInt(i)) {
        errors.push(`depth ${depth}: split value gap/dup at ${i}`);
        return;
      }
    }
    for (const kid of kids) {
      assign[depth] = B(kid.value);
      walk(kid.node, depth + 1);
    }
    assign[depth] = 0n;
  }

  walk(proof, 0);

  // Recompute the optimum independently from the surviving leaves.
  let best = null;
  let count = 0n;
  let vector = null;
  for (const leaf of leaves) {
    const better =
      best === null || leaf.qty > best.qty || (leaf.qty === best.qty && cmp(leaf.spend, best.spend) < 0);
    if (better) {
      best = leaf;
      count = 1n;
      vector = leaf.assign;
    } else if (leaf.qty === best.qty && cmp(leaf.spend, best.spend) === 0) {
      count += 1n;
      let less = false;
      for (let i = 0; i < n; i++) {
        if (leaf.assign[i] < vector[i]) { less = true; break; }
        if (leaf.assign[i] > vector[i]) break;
      }
      if (less) vector = leaf.assign;
    }
  }

  for (const p of boundPrunes) {
    if (best === null) {
      errors.push(`depth ${p.depth}: bound prune with no feasible leaves`);
    } else if (p.reason === 'bound-q') {
      if (p.ub >= best.qty) errors.push(`depth ${p.depth}: invalid 'bound-q' prune`);
    } else if (p.ub > best.qty || (p.ub === best.qty && cmp(p.lb, best.spend) <= 0)) {
      errors.push(`depth ${p.depth}: invalid 'bound-spend' prune`);
    }
  }

  const computed =
    best === null ? { qty: null, spend: null, count: 0n, vector: null } : { qty: best.qty, spend: best.spend, count, vector };

  if (best === null) {
    if (reported.qty !== null) errors.push('reported qty but no feasible leaf exists');
  } else {
    if (reported.qty === null || B(reported.qty) !== computed.qty) errors.push('reported qty mismatch');
    const rs = F(reported.spend);
    if (rs.num !== computed.spend.num || rs.den !== computed.spend.den) {
      errors.push('reported spend mismatch');
    }
    if (B(reported.count) !== computed.count) {
      errors.push(`reported count mismatch ${reported.count} != ${computed.count}`);
    }
    const rv = reported.vector.map(B);
    if (rv.length !== n || rv.some((v, i) => v !== computed.vector[i])) {
      errors.push('reported vector is not the lexicographically smallest optimum');
    }
  }
  return { ok: errors.length === 0, errors, computed };
}
