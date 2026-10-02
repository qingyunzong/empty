// 暴力枚举参考实现：不做费用剪枝与记忆化，用于与求解器交叉验证（≤8 任务）
import { genPlacements, comparePlans, EPS } from './solver.js';
import { SLOTS_PER_DAY } from './types.js';

export function bruteForce(spec) {
  const tasks = [...spec.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = tasks.length;
  const cands = tasks.map((t) => genPlacements(t, spec));
  if (cands.some((c) => c.length === 0)) return { status: 'INFEASIBLE' };

  const idIndex = new Map(tasks.map((t, i) => [t.id, i]));
  const orders = spec.orders.map((o) => [idIndex.get(o.a), idIndex.get(o.b)]);
  const placements = new Array(n);
  const load = new Float64Array(SLOTS_PER_DAY);
  let best = null;

  const rec = (i) => {
    if (i === n) {
      let cost = 0;
      let carbon = 0;
      let peak = 0;
      for (let s = 0; s < SLOTS_PER_DAY; s += 1) {
        cost += load[s] * spec.prices[s] * 0.25;
        carbon += load[s] * spec.carbonIntensity[s] * 0.25;
        if (load[s] > peak) peak = load[s];
      }
      const cand = { cost, carbon, peak, placements: placements.map((p) => p.slice()) };
      if (!best || comparePlans(cand, best, spec.objective) < 0) best = cand;
      return;
    }
    const t = tasks[i];
    for (const slots of cands[i]) {
      let fits = true;
      for (const s of slots) {
        if (load[s] + t.power > spec.capacity + EPS) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      placements[i] = slots;
      let ok = true;
      for (const [ai, bi] of orders) {
        if (ai <= i && bi <= i) {
          const pa = placements[ai];
          const pb = placements[bi];
          if (pa[pa.length - 1] >= pb[0]) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        for (const s of slots) load[s] += t.power;
        rec(i + 1);
        for (const s of slots) load[s] -= t.power;
      }
      placements[i] = undefined;
    }
  };
  rec(0);

  if (!best) return { status: 'INFEASIBLE' };
  return {
    status: 'FEASIBLE',
    cost: best.cost,
    carbon: best.carbon,
    peak: best.peak,
    schedule: tasks.map((t, i) => ({ task: t.id, slots: best.placements[i] })),
  };
}
