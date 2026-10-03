// Independent brute-force reference implementation used as a test oracle.
// Shares no code with src/: tiny local rationals, plain recursive enumeration
// over the step grid, and its own copy of the tie-break ladder.

function gcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1n;
}

export function R(n, d = 1n) {
  n = BigInt(n); d = BigInt(d);
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return [n / g, d / g];
}
const add = (a, b) => R(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
const mul = (a, b) => R(a[0] * b[0], a[1] * b[1]);
const cmp = (a, b) => {
  const l = a[0] * b[1];
  const r = b[0] * a[1];
  return l < r ? -1 : l > r ? 1 : 0;
};

function ok(op, c) {
  return op === '<=' ? c <= 0 : op === '>=' ? c >= 0 : op === '==' ? c === 0 : op === '<' ? c < 0 : c > 0;
}

function better(a, b) {
  let c = cmp(a.cost, b.cost);
  if (c) return c < 0;
  c = cmp(a.allergen, b.allergen);
  if (c) return c < 0;
  const n = Math.min(a.support.length, b.support.length);
  for (let i = 0; i < n; i++) {
    if (a.support[i] !== b.support[i]) return a.support[i] < b.support[i];
  }
  if (a.support.length !== b.support.length) return a.support.length < b.support.length;
  for (let i = 0; i < a.sortedGrams.length; i++) {
    if (a.sortedGrams[i] !== b.sortedGrams[i]) return a.sortedGrams[i] < b.sortedGrams[i];
  }
  return false;
}

// problem: {
//   ingredients: [{ name, costPerG: R, stockG: int, allergenPerG: R }],
//   totalG: int, stepG: int,
//   constraints: [{ lhs: (grams)=>R, op, rhs: (grams)=>R }],
//   objective: (grams)=>R,
// }
export function bruteForce(problem) {
  const { ingredients, totalG, stepG, constraints, objective } = problem;
  const n = ingredients.length;
  const units = totalG / stepG;
  const caps = ingredients.map((i) => Math.min(Math.floor(i.stockG / stepG), units));
  const grams = new Array(n).fill(0);
  let best = null;

  const visit = () => {
    for (const c of constraints) {
      if (!ok(c.op, cmp(c.lhs(grams), c.rhs(grams)))) return;
    }
    const cost = objective(grams);
    let allergen = R(0);
    for (let i = 0; i < n; i++) allergen = add(allergen, mul(ingredients[i].allergenPerG, R(grams[i])));
    const support = ingredients.map((ing, i) => [ing.name, grams[i]]).filter(([, g]) => g > 0).map(([nm]) => nm).sort();
    const sortedGrams = ingredients.map((ing, i) => [ing.name, grams[i]]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, g]) => g);
    const cand = { grams: grams.slice(), cost, allergen, support, sortedGrams };
    if (!best || better(cand, best)) best = cand;
  };

  const go = (idx, rest) => {
    if (idx === n) { if (rest === 0) visit(); return; }
    for (let k = 0; k <= Math.min(caps[idx], rest); k++) {
      grams[idx] = k * stepG;
      go(idx + 1, rest - k);
    }
    grams[idx] = 0;
  };
  go(0, units);
  return best;
}
