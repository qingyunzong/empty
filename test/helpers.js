// Test helpers: seeded RNG and a fully independent brute-force enumerator
// used to cross-check the solver on small instances.

import { frac, add, mul, cmp, ZERO } from '../src/fraction.js';
import { compareIds } from '../src/solver.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// Independent enumeration of every fill vector. Returns the optimal
// (volume, spend), the exact tie count and the lexicographically minimal
// vector (as an object keyed by order id over all problem orders).
export function bruteForce(problem) {
  const vars = [];
  for (const o of problem.orders) {
    const price = problem.prices[o.instrument];
    if (price === undefined) continue;
    if (o.qty === 0n) continue;
    const participates =
      o.side === 'buy' ? cmp(o.limit, price) >= 0 : cmp(o.limit, price) <= 0;
    if (!participates) continue;
    vars.push({ ...o, id: String(o.id), price });
  }
  vars.sort((x, y) => compareIds(x.id, y.id));

  let best = null;
  let count = 0n;
  let lexMin = null;
  const cur = new Array(vars.length).fill(0n);

  function lexLess(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] < b[i]) return true;
      if (a[i] > b[i]) return false;
    }
    return false;
  }

  function rec(k) {
    if (k === vars.length) {
      // Per-instrument buy/sell balance.
      const balance = new Map();
      let volume = 0n;
      let spend = ZERO;
      for (let j = 0; j < vars.length; j++) {
        const v = vars[j];
        const curBal = balance.get(v.instrument) || 0n;
        balance.set(v.instrument, v.side === 'buy' ? curBal + cur[j] : curBal - cur[j]);
        if (v.side === 'buy') {
          volume += cur[j];
          spend = add(spend, mul(v.price, frac(cur[j])));
        }
      }
      for (const b of balance.values()) if (b !== 0n) return;
      // Per-account funds.
      const spent = new Map();
      for (let j = 0; j < vars.length; j++) {
        const v = vars[j];
        if (v.side !== 'buy') continue;
        const curSpend = spent.get(v.account) || ZERO;
        spent.set(v.account, add(curSpend, mul(v.price, frac(cur[j]))));
      }
      for (const [acc, s] of spent) {
        const funds = problem.funds[acc] === undefined ? ZERO : problem.funds[acc];
        if (cmp(s, funds) > 0) return;
      }
      if (!best || volume > best.volume || (volume === best.volume && cmp(spend, best.spend) < 0)) {
        best = { volume, spend };
        count = 1n;
        lexMin = cur.slice();
      } else if (volume === best.volume && cmp(spend, best.spend) === 0) {
        count += 1n;
        if (lexLess(cur, lexMin)) lexMin = cur.slice();
      }
      return;
    }
    for (let q = 0n; q <= vars[k].qty; q++) {
      cur[k] = q;
      rec(k + 1);
    }
  }
  rec(0);

  const vector = {};
  for (const o of problem.orders) vector[String(o.id)] = 0n;
  if (lexMin) for (let j = 0; j < vars.length; j++) vector[vars[j].id] = lexMin[j];
  return {
    volume: best ? best.volume : 0n,
    spend: best ? best.spend : ZERO,
    count,
    vector,
  };
}

export function randomProblem(rng, { maxOrders = 6, maxQty = 3 } = {}) {
  const nAccounts = randInt(rng, 1, 3);
  const nInstruments = randInt(rng, 1, 3);
  const nOrders = randInt(rng, 1, maxOrders);
  const accounts = [];
  const instruments = [];
  for (let a = 0; a < nAccounts; a++) accounts.push(`A${a}`);
  for (let i = 0; i < nInstruments; i++) instruments.push(`I${i}`);
  const prices = {};
  for (const iid of instruments) {
    prices[iid] = frac(BigInt(randInt(rng, 0, 5)), BigInt(randInt(rng, 1, 4)));
  }
  const funds = {};
  for (const aid of accounts) {
    funds[aid] = frac(BigInt(randInt(rng, 0, 12)), BigInt(randInt(rng, 1, 2)));
  }
  const orders = [];
  for (let o = 0; o < nOrders; o++) {
    orders.push({
      id: `O${o}`,
      account: accounts[randInt(rng, 0, nAccounts - 1)],
      side: rng() < 0.5 ? 'buy' : 'sell',
      instrument: instruments[randInt(rng, 0, nInstruments - 1)],
      qty: BigInt(randInt(rng, 0, maxQty)),
      limit: frac(BigInt(randInt(rng, 0, 6)), BigInt(randInt(rng, 1, 4))),
    });
  }
  return { orders, prices, funds };
}
