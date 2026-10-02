// plan.json 构建与独立校验（verify 复用编译器 + VM 重算负荷/费用/碳排/峰值）
import { VM } from './vm.js';
import { compilePlan } from './compiler.js';
import { SLOTS_PER_DAY } from './types.js';

const r6 = (x) => Math.round(x * 1e6) / 1e6;
const TOL = 1e-6;

export function buildPlan(spec, result) {
  return {
    version: 1,
    status: result.status,
    site: {
      name: spec.name,
      capacity: spec.capacity === Infinity ? null : spec.capacity,
      prices: spec.prices,
      carbonIntensity: spec.carbonIntensity,
      maintenance: [...spec.maintenance],
      tasks: spec.tasks.map((t) => ({
        id: t.id,
        power: t.power,
        durationSlots: t.durationSlots,
        window: [...t.window],
        interruptible: t.interruptible,
        maxInterruptions: t.maxInterruptions,
      })),
      orders: spec.orders.map((o) => [o.a, o.b]),
    },
    budget: { cost: spec.budgets.cost, carbon: spec.budgets.carbon },
    schedule: result.schedule.map((s) => ({ task: s.task, slots: [...s.slots] })),
    objective: { cost: r6(result.cost), peak: r6(result.peak), carbon: r6(result.carbon) },
  };
}

function countRuns(slots) {
  let runs = 1;
  for (let i = 1; i < slots.length; i += 1) {
    if (slots[i] !== slots[i - 1] + 1) runs += 1;
  }
  return runs;
}

export function verifyPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, errors: ['计划不是 JSON 对象'] };
  }
  if (plan.version !== 1) errors.push(`不支持的版本 ${plan.version}`);
  if (plan.status !== 'FEASIBLE' && plan.status !== 'OVER_BUDGET' && plan.status !== 'INFEASIBLE') {
    errors.push(`未知状态 "${plan.status}"`);
  }
  if (plan.status === 'INFEASIBLE') {
    return { ok: errors.length === 0, errors };
  }
  const site = plan.site;
  if (!site || typeof site !== 'object') {
    return { ok: false, errors: [...errors, '缺少 site 段'] };
  }
  const prices = site.prices;
  const carbonIntensity = site.carbonIntensity;
  if (!Array.isArray(prices) || prices.length !== SLOTS_PER_DAY) errors.push('prices 必须是 96 元素数组');
  if (!Array.isArray(carbonIntensity) || carbonIntensity.length !== SLOTS_PER_DAY) {
    errors.push('carbonIntensity 必须是 96 元素数组');
  }
  if (errors.length > 0) return { ok: false, errors };

  const capacity = site.capacity == null ? Infinity : site.capacity;
  const maintenance = Array.isArray(site.maintenance) ? site.maintenance : [];
  const tasks = new Map();
  for (const t of site.tasks || []) {
    if (tasks.has(t.id)) errors.push(`任务 "${t.id}" 重复`);
    tasks.set(t.id, t);
  }
  const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
  const seen = new Set();
  const placedByTask = new Map();
  for (const item of schedule) {
    const t = tasks.get(item.task);
    if (!t) {
      errors.push(`计划中出现未知任务 "${item.task}"`);
      continue;
    }
    if (seen.has(item.task)) errors.push(`任务 "${item.task}" 被重复调度`);
    seen.add(item.task);
    const slots = item.slots;
    if (!Array.isArray(slots) || slots.some((s) => !Number.isInteger(s) || s < 0 || s >= SLOTS_PER_DAY)) {
      errors.push(`任务 "${item.task}" 槽位非法`);
      continue;
    }
    for (let i = 1; i < slots.length; i += 1) {
      if (slots[i] <= slots[i - 1]) errors.push(`任务 "${item.task}" 槽位未严格递增`);
    }
    if (slots.length !== t.durationSlots) {
      errors.push(`任务 "${item.task}" 槽位数 ${slots.length} 与时长 ${t.durationSlots} 不符`);
    }
    if (slots.length > 0 && (slots[0] < t.window[0] || slots[slots.length - 1] >= t.window[1])) {
      errors.push(`任务 "${item.task}" 超出窗口 [${t.window[0]}, ${t.window[1]})`);
    }
    const maxRuns = t.interruptible ? t.maxInterruptions + 1 : 1;
    if (slots.length > 0 && countRuns(slots) > maxRuns) {
      errors.push(`任务 "${item.task}" 中断次数超限`);
    }
    placedByTask.set(item.task, slots);
  }
  for (const id of tasks.keys()) {
    if (!seen.has(id)) errors.push(`任务 "${id}" 未被调度`);
  }
  for (const [a, b] of site.orders || []) {
    const pa = placedByTask.get(a);
    const pb = placedByTask.get(b);
    if (pa && pb && pa[pa.length - 1] >= pb[0]) {
      errors.push(`先后关系 ${a} before ${b} 被违反`);
    }
  }

  const spec = {
    capacity,
    prices,
    carbonIntensity,
    maintenance,
    tasks: [...tasks.values()],
  };
  const knownSchedule = schedule.filter((item) => tasks.has(item.task));
  const res = new VM().run(compilePlan(spec, knownSchedule));
  if (!res.ok) errors.push(...res.violations);

  const obj = plan.objective || {};
  if (Math.abs(res.cost - obj.cost) > TOL) errors.push(`费用不符：记录 ${obj.cost}，重算 ${r6(res.cost)}`);
  if (Math.abs(res.peak - obj.peak) > TOL) errors.push(`峰值不符：记录 ${obj.peak}，重算 ${r6(res.peak)}`);
  if (Math.abs(res.carbon - obj.carbon) > TOL) errors.push(`碳排不符：记录 ${obj.carbon}，重算 ${r6(res.carbon)}`);

  const budget = plan.budget || {};
  const overCost = budget.cost != null && res.cost > budget.cost + TOL;
  const overCarbon = budget.carbon != null && res.carbon > budget.carbon + TOL;
  if (plan.status === 'FEASIBLE' && (overCost || overCarbon)) {
    errors.push('超过预算但状态为 FEASIBLE');
  }
  if (plan.status === 'OVER_BUDGET' && !overCost && !overCarbon) {
    errors.push('未超预算但状态为 OVER_BUDGET');
  }
  return { ok: errors.length === 0, errors };
}
