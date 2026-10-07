import { buildSlots, enumerateDayCombos, lexBetter } from "./solver.js";
import type { WarehouseInput, WarehousePlan } from "./types.js";

export interface Optimum {
  dev: number;
  cost: number;
}

/**
 * 独立有限状态搜索：与 solver 的后向 DP 不同，这里把问题显式建成
 * (日, 期初库存) 状态图，从 (0, 初始库存) 出发做前向 Dijkstra（字典序权重），
 * 用于交叉核对求解器给出的最优值。
 */
export function dijkstraOptimum(
  wh: WarehouseInput,
  horizon: number,
  replan: boolean,
): Optimum | null {
  const slots = buildSlots(wh, horizon);
  const fixedCosts = wh.channels.map((c) => c.fixedCost);
  const dayCombos = slots.map((s) => enumerateDayCombos(s, fixedCosts));
  const width = wh.capacity + 1;

  const distDev: number[][] = [];
  const distCost: number[][] = [];
  for (let t = 0; t <= horizon; t++) {
    distDev.push(new Array<number>(width).fill(INF));
    distCost.push(new Array<number>(width).fill(INF));
  }
  const init = wh.initialInventory;
  if (!Number.isInteger(init) || init < 0 || init > wh.capacity) return null;
  distDev[0]![init] = 0;
  distCost[0]![init] = 0;

  // 二叉堆，元素 [dev, cost, t, inv]，按 (dev, cost) 字典序弹出
  const heap: number[][] = [[0, 0, 0, init]];
  const less = (a: number[], b: number[]): boolean =>
    a[0]! < b[0]! || (a[0] === b[0] && a[1]! < b[1]!);
  const push = (item: number[]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(heap[i]!, heap[p]!)) {
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      } else break;
    }
  };
  const pop = (): number[] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };

  while (heap.length > 0) {
    const [dev, cost, t, inv] = pop() as [number, number, number, number];
    if (dev !== distDev[t]![inv]! || cost !== distCost[t]![inv]!) continue; // 过期堆元素
    if (t === horizon) return { dev, cost }; // 首个出队的终点即最优
    const demand = wh.demand[t]!;
    for (const combo of dayCombos[t]!) {
      const end = inv + combo.total - demand;
      if (end < 0 || end > wh.capacity) continue;
      const nd = dev + (replan ? combo.dev : 0);
      const nc = cost + combo.fixed + wh.holdingCost * end;
      if (lexBetter(nd, nc, distDev[t + 1]![end]!, distCost[t + 1]![end]!)) {
        distDev[t + 1]![end] = nd;
        distCost[t + 1]![end] = nc;
        push([nd, nc, t + 1, end]);
      }
    }
  }
  return null;
}

const INF = Number.POSITIVE_INFINITY;

/**
 * 短周期枚举对照：不做任何记忆化，纯递归枚举全部可行计划，
 * 仅按可行性剪枝，直接比较完整计划的字典序费用。
 */
export function enumerateOptimum(
  wh: WarehouseInput,
  horizon: number,
  replan: boolean,
): (Optimum & { explored: number }) | null {
  const slots = buildSlots(wh, horizon);
  const fixedCosts = wh.channels.map((c) => c.fixedCost);
  const dayCombos = slots.map((s) => enumerateDayCombos(s, fixedCosts));
  let bestDev = INF;
  let bestCost = INF;
  let explored = 0;

  const rec = (t: number, inv: number, dev: number, cost: number): void => {
    if (t === horizon) {
      explored++;
      if (lexBetter(dev, cost, bestDev, bestCost)) {
        bestDev = dev;
        bestCost = cost;
      }
      return;
    }
    const demand = wh.demand[t]!;
    for (const combo of dayCombos[t]!) {
      const end = inv + combo.total - demand;
      if (end < 0 || end > wh.capacity) continue;
      rec(
        t + 1,
        end,
        dev + (replan ? combo.dev : 0),
        cost + combo.fixed + wh.holdingCost * end,
      );
    }
  };
  const init = wh.initialInventory;
  if (!Number.isInteger(init) || init < 0 || init > wh.capacity) return null;
  rec(0, init, 0, 0);
  if (bestDev === INF) return null;
  return { dev: bestDev, cost: bestCost, explored };
}

/**
 * 证书校验：对求解结果逐日核对守恒、仓容、无缺货、锁定/在途约束，
 * 并重算费用与偏差，返回违规信息列表（空 = 通过）。
 */
export function checkCertificate(
  wh: WarehouseInput,
  horizon: number,
  plan: WarehousePlan,
  replan: boolean,
): string[] {
  const violations: string[] = [];
  const slots = buildSlots(wh, horizon);
  const fixedOf = new Map(wh.channels.map((c, i) => [c.name, i]));

  if (plan.days.length !== horizon) {
    violations.push(`天数记录 ${plan.days.length} 与规划期 ${horizon} 不符`);
    return violations;
  }

  let inv = wh.initialInventory;
  let orderingCost = 0;
  let holdingCostTotal = 0;
  let deviation = 0;
  const orderSet = new Set(plan.orders.map((o) => `${o.day}|${o.channel}|${o.qty}`));

  for (let t = 0; t < horizon; t++) {
    const rec = plan.days[t]!;
    if (rec.day !== t) violations.push(`第 ${t} 天记录序号错误`);
    if (rec.startInventory !== inv) {
      violations.push(`第 ${t} 天期初库存 ${rec.startInventory} ≠ 上日期末 ${inv}`);
    }
    let arrived = 0;
    for (const a of rec.arrivals) {
      const ci = fixedOf.get(a.channel);
      if (ci === undefined) {
        violations.push(`第 ${t} 天到货渠道未知: ${a.channel}`);
        continue;
      }
      if (!Number.isInteger(a.qty) || a.qty <= 0) {
        violations.push(`第 ${t} 天到货量非法: ${a.qty}`);
      }
      const slot = slots[t]![ci]!;
      if (a.qty < slot.lo) {
        violations.push(`第 ${t} 天 ${a.channel} 到货 ${a.qty} 低于锁定下限 ${slot.lo}`);
      }
      if (a.qty > slot.hi) {
        violations.push(`第 ${t} 天 ${a.channel} 到货 ${a.qty} 超过可执行上限 ${slot.hi}（在途订单不可增量）`);
      }
      if (!orderSet.has(`${t}|${a.channel}|${a.qty}`)) {
        violations.push(`第 ${t} 天 ${a.channel} 到货 ${a.qty} 未出现在订单列表`);
      }
      deviation += Math.abs(a.qty - slot.pub);
      orderingCost += wh.channels[ci]!.fixedCost;
      arrived += a.qty;
    }
    // 槽位无到货时偏差也要计入（已公布被撤销的部分）
    for (let ci = 0; ci < wh.channels.length; ci++) {
      const had = rec.arrivals.some((a) => a.channel === wh.channels[ci]!.name);
      if (!had) deviation += Math.abs(0 - slots[t]![ci]!.pub);
    }
    const end = inv + arrived - rec.demand;
    if (end !== rec.endInventory) {
      violations.push(
        `第 ${t} 天不守恒: ${inv} + ${arrived} - ${rec.demand} = ${end} ≠ 记录期末 ${rec.endInventory}`,
      );
    }
    if (end < 0) violations.push(`第 ${t} 天缺货（期末 ${end} < 0）`);
    if (end > wh.capacity) violations.push(`第 ${t} 天超仓容（期末 ${end} > ${wh.capacity}）`);
    if (rec.demand !== wh.demand[t]) violations.push(`第 ${t} 天需求记录不符`);
    if (rec.holdingCost !== wh.holdingCost * end) {
      violations.push(`第 ${t} 天持有费记录不符`);
    }
    holdingCostTotal += rec.holdingCost;
    inv = rec.endInventory;
  }

  for (const o of plan.orders) {
    const ci = fixedOf.get(o.channel);
    if (ci === undefined) {
      violations.push(`订单渠道未知: ${o.channel}`);
      continue;
    }
    if (o.placeDay !== o.day - wh.channels[ci]!.leadTime) {
      violations.push(`订单(${o.day},${o.channel},${o.qty}) 下单日计算错误`);
    }
  }

  if (plan.orderingCost !== orderingCost) {
    violations.push(`启单费合计 ${plan.orderingCost} ≠ 重算 ${orderingCost}`);
  }
  if (plan.holdingCostTotal !== holdingCostTotal) {
    violations.push(`持有费合计 ${plan.holdingCostTotal} ≠ 重算 ${holdingCostTotal}`);
  }
  if (plan.totalCost !== orderingCost + holdingCostTotal) {
    violations.push(`总费 ${plan.totalCost} ≠ ${orderingCost} + ${holdingCostTotal}`);
  }
  if (replan && plan.deviation !== deviation) {
    violations.push(`偏差 ${plan.deviation} ≠ 重算 ${deviation}`);
  }
  return violations;
}
