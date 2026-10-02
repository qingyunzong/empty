// 求解器：按任务 ID 字典序 DFS，分支限界 + 状态记忆化
// 目标：最小化目标表达式（默认 cost）；并列最优依次取峰值较低、任务 ID 字典序较小方案
import { VM } from './vm.js';
import { compilePlacement } from './compiler.js';
import { SLOTS_PER_DAY } from './types.js';

export const EPS = 1e-9;
export const CMP_EPS = 1e-6;

export function evalObjective(expr, vals) {
  if (!expr) return vals.cost;
  switch (expr.kind) {
    case 'num':
      return expr.value;
    case 'var':
      return vals[expr.name];
    case 'neg':
      return -evalObjective(expr.expr, vals);
    case 'bin': {
      const l = evalObjective(expr.left, vals);
      const r = evalObjective(expr.right, vals);
      switch (expr.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        default: throw new Error(`未知运算符 ${expr.op}`);
      }
    }
    default:
      throw new Error('无效目标表达式');
  }
}

function cmpSlotArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// a < b 返回负数。目标值 -> 峰值 -> 逐任务槽位字典序（任务已按 ID 排序）
export function comparePlans(a, b, objective) {
  const oa = evalObjective(objective, a);
  const ob = evalObjective(objective, b);
  if (Math.abs(oa - ob) > CMP_EPS) return oa - ob;
  if (Math.abs(a.peak - b.peak) > CMP_EPS) return a.peak - b.peak;
  for (let i = 0; i < a.placements.length; i += 1) {
    const c = cmpSlotArrays(a.placements[i], b.placements[i]);
    if (c !== 0) return c;
  }
  return 0;
}

function countRuns(slots) {
  let runs = 1;
  for (let i = 1; i < slots.length; i += 1) {
    if (slots[i] !== slots[i - 1] + 1) runs += 1;
  }
  return runs;
}

const MAX_PLACEMENTS = 200000;

// 生成任务的全部候选摆放（槽位数组，升序字典序）
export function genPlacements(task, spec) {
  const [w0, w1] = task.window;
  const d = task.durationSlots;
  const maint = spec.maintenanceSet;
  const out = [];
  const maxRuns = task.interruptible ? task.maxInterruptions + 1 : 1;
  if (task.power > spec.capacity + EPS) return out;
  if (maxRuns === 1) {
    for (let s = w0; s + d <= w1; s += 1) {
      const slots = [];
      for (let k = 0; k < d; k += 1) slots.push(s + k);
      if (slots.some((x) => maint.has(x))) continue;
      out.push(slots);
    }
    return out;
  }
  const pool = [];
  for (let s = w0; s < w1; s += 1) {
    if (!maint.has(s)) pool.push(s);
  }
  const combo = [];
  const rec = (startIdx) => {
    if (combo.length === d) {
      if (countRuns(combo) <= maxRuns) {
        out.push([...combo]);
        if (out.length > MAX_PLACEMENTS) {
          throw new Error(`任务 "${task.id}" 候选摆放过多，请缩小窗口或限制中断次数`);
        }
      }
      return;
    }
    const need = d - combo.length;
    for (let i = startIdx; i <= pool.length - need; i += 1) {
      combo.push(pool[i]);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
  return out;
}

function ordersSatisfied(orders, placements, upto) {
  for (const [ai, bi] of orders) {
    if (ai <= upto && bi <= upto) {
      const pa = placements[ai];
      const pb = placements[bi];
      if (pa[pa.length - 1] >= pb[0]) return false;
    }
  }
  return true;
}

export function solve(spec, vm = new VM()) {
  const tasks = [...spec.tasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const n = tasks.length;
  const cands = tasks.map((t) => genPlacements(t, spec));
  if (cands.some((c) => c.length === 0)) return { status: 'INFEASIBLE' };

  const idIndex = new Map(tasks.map((t, i) => [t.id, i]));
  const orders = spec.orders.map((o) => [idIndex.get(o.a), idIndex.get(o.b)]);

  const pureCost = !spec.objective
    || (spec.objective.kind === 'var' && spec.objective.name === 'cost');

  // 剩余任务费用下界（仅纯 cost 目标时用于剪枝）
  const lb = new Array(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i -= 1) {
    const t = tasks[i];
    let minPrice = Infinity;
    for (let s = t.window[0]; s < t.window[1]; s += 1) {
      if (spec.prices[s] < minPrice) minPrice = spec.prices[s];
    }
    lb[i] = lb[i + 1] + minPrice * t.power * 0.25 * t.durationSlots;
  }

  const placements = new Array(n);
  const load = new Float64Array(SLOTS_PER_DAY);
  const memo = new Map();
  let best = null;

  const placementCost = (task, slots) => {
    const key = `${task.id}@${slots.join(',')}`;
    return vm.run(compilePlacement(task, slots, spec), key);
  };

  const dfs = (i, cost, carbon) => {
    if (i === n) {
      let peak = 0;
      for (const v of load) if (v > peak) peak = v;
      const cand = { cost, carbon, peak, placements: placements.map((p) => p.slice()) };
      if (!best || comparePlans(cand, best, spec.objective) < 0) best = cand;
      return;
    }
    if (pureCost) {
      if (best && cost + lb[i] > best.cost + CMP_EPS) return;
      const key = `${i}|${Array.from(load).join(',')}`;
      const prev = memo.get(key);
      if (prev !== undefined && prev <= cost + CMP_EPS) return;
      memo.set(key, cost);
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
      if (!ordersSatisfied(orders, placements, i)) {
        placements[i] = undefined;
        continue;
      }
      for (const s of slots) load[s] += t.power;
      const pc = placementCost(t, slots);
      dfs(i + 1, cost + pc.cost, carbon + pc.carbon);
      for (const s of slots) load[s] -= t.power;
      placements[i] = undefined;
    }
  };
  dfs(0, 0, 0);

  if (!best) return { status: 'INFEASIBLE' };
  return {
    status: 'FEASIBLE',
    cost: best.cost,
    carbon: best.carbon,
    peak: best.peak,
    schedule: tasks.map((t, i) => ({ task: t.id, slots: best.placements[i] })),
  };
}
