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

export function randomSpec(seed, n) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const steps = [];
  for (let i = 0; i < n; i++) {
    const nParams = 1 + Math.floor(rnd() * 2);
    const params = [];
    for (let k = 0; k < nParams; k++) params.push("v" + k);
    steps.push({
      id: "s" + i,
      params,
      memory: 1 + Math.floor(rnd() * 3),
      duration: 1 + Math.floor(rnd() * 2),
    });
  }
  const edges = [];
  const compat = {};
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (rnd() < 0.35) {
        edges.push(["s" + i, "s" + j]);
        if (rnd() < 0.6) {
          const table = {};
          for (const pu of steps[i].params) {
            const allowed = steps[j].params.filter(() => rnd() < 0.7);
            table[pu] = allowed;
          }
          compat["s" + i + ">s" + j] = table;
        }
      }
    }
  }
  const mutex = [];
  if (n >= 2 && rnd() < 0.4) {
    const a = Math.floor(rnd() * n);
    const b = Math.floor(rnd() * n);
    if (a !== b) mutex.push(a < b ? ["s" + a, "s" + b] : ["s" + b, "s" + a]);
  }
  return {
    machines: pick([1, 2]),
    memoryLimit: 4 + Math.floor(rnd() * 3),
    steps,
    edges,
    compat,
    mutex,
  };
}
