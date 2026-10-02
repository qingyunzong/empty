// Seeded PRNG (mulberry32) for reproducible random instances.
export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInstance(rand, { varCount, domainSize = 3, ruleCount = 4 }) {
  const names = Array.from({ length: varCount }, (_, i) => `v${i}`);
  const data = {};
  const schema = {};
  for (const n of names) {
    const domain = Array.from({ length: domainSize }, (_, i) => i);
    data[n] = domain[Math.floor(rand() * domain.length)];
    schema[n] = { domain, changeCost: 1 + Math.floor(rand() * 3) };
  }
  const rules = [];
  for (let i = 0; i < ruleCount; i++) {
    const kind = Math.floor(rand() * 4);
    if (kind === 0) {
      const v = names[Math.floor(rand() * names.length)];
      rules.push({
        id: `r${i}`,
        type: 'range',
        var: v,
        min: Math.floor(rand() * 2),
        max: domainSize - 1 - Math.floor(rand() * 2),
      });
    } else if (kind === 1 && names.length >= 2) {
      const a = names[Math.floor(rand() * names.length)];
      let b = names[Math.floor(rand() * names.length)];
      if (a === b) b = names[(names.indexOf(a) + 1) % names.length];
      rules.push({ id: `r${i}`, type: 'eq', vars: [a, b] });
    } else if (kind === 2 && names.length >= 2) {
      const a = names[Math.floor(rand() * names.length)];
      let b = names[Math.floor(rand() * names.length)];
      if (a === b) b = names[(names.indexOf(a) + 1) % names.length];
      rules.push({ id: `r${i}`, type: 'neq', vars: [a, b] });
    } else {
      const k = 1 + Math.floor(rand() * Math.min(3, names.length));
      const shuffled = [...names];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const s = Math.floor(rand() * (j + 1));
        [shuffled[j], shuffled[s]] = [shuffled[s], shuffled[j]];
      }
      const vars = shuffled.slice(0, k);
      rules.push({ id: `r${i}`, type: 'sum_lte', vars, limit: Math.floor(rand() * domainSize * k) });
    }
  }
  return { data, schema, rules };
}

// Independent brute-force oracle: minimum cost of a full assignment that
// satisfies every rule and stays within budget, or null when none exists.
export function bruteForceOptimum(data, schema, rules, budget, evaluate) {
  const names = Object.keys(schema).sort();
  const assign = {};
  let best = null;
  function changeCost(name, value) {
    if (value === data[name]) return 0;
    const spec = schema[name];
    if (spec.costPerUnit !== undefined) return spec.costPerUnit * Math.abs(value - data[name]);
    return spec.changeCost ?? 1;
  }
  function visit(idx, total) {
    if (idx === names.length) {
      const violated = rules.some((r) => evaluate(r, assign) !== null);
      if (!violated && total <= budget && (best === null || total < best)) best = total;
      return;
    }
    const name = names[idx];
    for (const value of schema[name].domain) {
      assign[name] = value;
      visit(idx + 1, total + changeCost(name, value));
    }
  }
  visit(0, 0);
  return best;
}
