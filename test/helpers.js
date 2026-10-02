import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function randomDag(rng, n, edgeP = 0.15) {
  const ids = Array.from({ length: n }, (_, i) => `t${i}`);
  const order = [...ids];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const posOf = new Map(order.map((id, p) => [id, p]));
  const tasks = order.map((id, pos) => {
    const deps = order.slice(0, pos).filter(() => rng() < edgeP);
    const res = () => (rng() < 0.2 ? null : 1 + Math.floor(rng() * 4));
    return {
      id,
      deps,
      cpu: res(),
      mem: res(),
      wall: res(),
      failRate: rng() < 0.3 ? null : Math.floor(rng() * 10) / 10,
      value: 1 + Math.floor(rng() * 3),
    };
  });
  void posOf;
  return { tasks };
}

export function randomBudget(rng, dagObj) {
  const total = { cpu: 0, mem: 0, wall: 0 };
  for (const t of dagObj.tasks) {
    for (const d of ['cpu', 'mem', 'wall']) total[d] += t[d] ?? 0;
  }
  const out = {};
  for (const d of ['cpu', 'mem', 'wall']) {
    const r = rng();
    if (r < 0.1) out[d] = null;
    else if (r < 0.2) out[d] = total[d]; // exact boundary
    else out[d] = Math.floor(total[d] * (0.35 + rng() * 0.75));
  }
  return out;
}

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'replan-test-'));
}

export function writeJson(dir, name, obj) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
