import { normalizeConfig } from '../src/config.js';
import { Engine } from '../src/engine.js';
import { runSimulation, taskRunCost } from '../src/scheduler.js';

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

export function makeEngine(overrides = {}) {
  return new Engine(normalizeConfig(overrides));
}

export function run(engine, ops) {
  return runSimulation(engine, ops);
}

// Independent brute-force minimum makespan: enumerate every assignment of
// tasks to channels and every permutation within each channel.
export function bruteForceMakespan(tasks, channelTemps, config) {
  const n = tasks.length;
  const C = channelTemps.length;
  let best = Infinity;
  const buckets = Array.from({ length: C }, () => []);

  function channelCost(subset, startTemp) {
    if (subset.length === 0) return 0;
    let min = Infinity;
    const arr = subset.slice();
    const rec = (k) => {
      if (k === 1) {
        let temp = startTemp;
        let cost = 0;
        for (const i of arr) {
          const r = taskRunCost(temp, tasks[i], config);
          cost += r.cost;
          temp = r.endTemp;
        }
        if (cost < min) min = cost;
        return;
      }
      for (let i = 0; i < k; i++) {
        rec(k - 1);
        const j = k % 2 === 0 ? i : 0;
        [arr[j], arr[k - 1]] = [arr[k - 1], arr[j]];
      }
    };
    rec(arr.length);
    return min;
  }

  const rec = (i) => {
    if (i === n) {
      let mk = 0;
      for (let c = 0; c < C; c++) mk = Math.max(mk, channelCost(buckets[c], channelTemps[c]));
      if (mk < best) best = mk;
      return;
    }
    for (let c = 0; c < C; c++) {
      buckets[c].push(i);
      rec(i + 1);
      buckets[c].pop();
    }
  };
  rec(0);
  return best;
}
