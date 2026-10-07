import type {
  DayRecord,
  OrderDecision,
  Scenario,
  WarehouseInput,
  WarehousePlan,
} from "./types.js";

/**
 * 每个 (到货日, 渠道) 槽位的可行下单区间与偏差基准：
 *  - lo: 锁定下限（已发出订单的锁定部分不可撤销）
 *  - hi: 上限。下单日 >= 0 的槽位可任意加单（上界取 仓容+当日需求，足够覆盖一切可行流）；
 *        下单日 < 0 的在途订单只能撤销未锁定部分、不能增量，故 hi = 已公布量
 *  - pub: 已公布量，重规划偏差 |新量 - pub| 的基准
 */
export interface SlotBound {
  lo: number;
  hi: number;
  pub: number;
}

/** 某日到货的一种渠道组合。 */
export interface Combo {
  qs: number[]; // 各渠道到货量
  total: number;
  dev: number; // Σ|q_c - pub_c|
  fixed: number; // Σ 启单费（q_c > 0 计一次）
}

const INF = Number.POSITIVE_INFINITY;

/** 字典序比较：(dev, cost) 是否优于 (bDev, bCost)。 */
export function lexBetter(aDev: number, aCost: number, bDev: number, bCost: number): boolean {
  return aDev < bDev || (aDev === bDev && aCost < bCost);
}

export function buildSlots(wh: WarehouseInput, horizon: number): SlotBound[][] {
  const slots: SlotBound[][] = [];
  for (let t = 0; t < horizon; t++) {
    slots.push(
      wh.channels.map((ch) => ({
        lo: 0,
        hi: t - ch.leadTime >= 0 ? wh.capacity + wh.demand[t]! : 0,
        pub: 0,
      })),
    );
  }
  for (const o of wh.published ?? []) {
    const ci = wh.channels.findIndex((c) => c.name === o.channel);
    if (ci < 0) throw new Error(`未知渠道 "${o.channel}"（仓库 ${wh.id}）`);
    if (!Number.isInteger(o.qty) || !Number.isInteger(o.locked) || o.locked < 0 || o.locked > o.qty) {
      throw new Error(`非法已公布订单（仓库 ${wh.id}）: ${JSON.stringify(o)}`);
    }
    if (o.day < 0 || o.day >= horizon) continue; // 窗口外的已公布订单与本规划无关
    const slot = slots[o.day]![ci]!;
    slot.pub += o.qty;
    slot.lo += o.locked;
    const placeable = o.day - wh.channels[ci]!.leadTime >= 0;
    slot.hi = placeable ? Math.max(slot.hi, slot.pub) : slot.pub;
    if (slot.lo > slot.hi) {
      throw new Error(`锁定量超过可执行上限（仓库 ${wh.id} 第 ${o.day} 天 ${o.channel}）`);
    }
  }
  return slots;
}

/** 枚举某日所有渠道到货组合；同一到货总量只保留字典序最优的拆分明细。 */
export function enumerateDayCombos(slots: SlotBound[], fixedCosts: number[]): Combo[] {
  const best = new Map<number, Combo>();
  const qs = new Array<number>(slots.length).fill(0);
  const rec = (c: number, total: number, dev: number, fixed: number): void => {
    if (c === slots.length) {
      const cur = best.get(total);
      if (!cur || lexBetter(dev, fixed, cur.dev, cur.fixed)) {
        best.set(total, { qs: qs.slice(), total, dev, fixed });
      }
      return;
    }
    const s = slots[c]!;
    for (let q = s.lo; q <= s.hi; q++) {
      qs[c] = q;
      rec(c + 1, total + q, dev + Math.abs(q - s.pub), fixed + (q > 0 ? fixedCosts[c]! : 0));
    }
  };
  rec(0, 0, 0, 0);
  return [...best.values()];
}

/**
 * 单仓后向动态规划。
 * 状态 = (当日, 期初库存)；决策 = 当日至各渠道到货量（到货在日需求前）；
 * 约束 = 期末库存 ∈ [0, 仓容]（禁止缺货）；费用 = 启单费 + 期末库存 × 持有费。
 * replan=true 时目标为字典序：先最少改已公布下单量（Σ|新-已公布|），再总费用少。
 */
export function solveWarehouse(
  wh: WarehouseInput,
  horizon: number,
  replan: boolean,
): WarehousePlan | null {
  const slots = buildSlots(wh, horizon);
  const fixedCosts = wh.channels.map((c) => c.fixedCost);
  const dayCombos = slots.map((s) => enumerateDayCombos(s, fixedCosts));
  const width = wh.capacity + 1;
  let nextDev = new Array<number>(width).fill(0);
  let nextCost = new Array<number>(width).fill(0);
  const choices: (Combo | null)[][] = new Array<(Combo | null)[]>(horizon);

  for (let t = horizon - 1; t >= 0; t--) {
    const demand = wh.demand[t]!;
    const curDev = new Array<number>(width).fill(INF);
    const curCost = new Array<number>(width).fill(INF);
    const curChoice = new Array<Combo | null>(width).fill(null);
    for (let inv = 0; inv <= wh.capacity; inv++) {
      for (const combo of dayCombos[t]!) {
        const end = inv + combo.total - demand;
        if (end < 0 || end > wh.capacity) continue;
        const nd = nextDev[end]!;
        if (nd === INF) continue;
        const dev = (replan ? combo.dev : 0) + nd;
        const cost = combo.fixed + wh.holdingCost * end + nextCost[end]!;
        if (lexBetter(dev, cost, curDev[inv]!, curCost[inv]!)) {
          curDev[inv] = dev;
          curCost[inv] = cost;
          curChoice[inv] = combo;
        }
      }
    }
    choices[t] = curChoice;
    nextDev = curDev;
    nextCost = curCost;
  }

  const init = wh.initialInventory;
  if (!Number.isInteger(init) || init < 0 || init > wh.capacity || nextDev[init]! === INF) {
    return null; // 不可行
  }

  const days: DayRecord[] = [];
  const orders: OrderDecision[] = [];
  let inv = init;
  let orderingCost = 0;
  let holdingCostTotal = 0;
  let deviation = 0;
  for (let t = 0; t < horizon; t++) {
    const combo = choices[t]![inv]!;
    const arrivals: { channel: string; qty: number }[] = [];
    for (let ci = 0; ci < combo.qs.length; ci++) {
      const q = combo.qs[ci]!;
      deviation += Math.abs(q - slots[t]![ci]!.pub);
      if (q > 0) {
        const channel = wh.channels[ci]!;
        arrivals.push({ channel: channel.name, qty: q });
        orders.push({ day: t, channel: channel.name, qty: q, placeDay: t - channel.leadTime });
      }
    }
    const end = inv + combo.total - wh.demand[t]!;
    const hold = wh.holdingCost * end;
    orderingCost += combo.fixed;
    holdingCostTotal += hold;
    days.push({
      day: t,
      startInventory: inv,
      arrivals,
      demand: wh.demand[t]!,
      endInventory: end,
      holdingCost: hold,
    });
    inv = end;
  }

  return {
    warehouseId: wh.id,
    orders,
    days,
    orderingCost,
    holdingCostTotal,
    totalCost: orderingCost + holdingCostTotal,
    deviation: replan ? deviation : 0,
  };
}

export interface ScenarioResult {
  plans: (WarehousePlan | null)[];
  feasible: boolean;
  totalCost: number;
}

/** 多仓求解：各仓容量独立、需求独立，逐仓求解后汇总。 */
export function solveScenario(sc: Scenario, replan: boolean): ScenarioResult {
  const plans = sc.warehouses.map((wh) => solveWarehouse(wh, sc.horizon, replan));
  const feasible = plans.every((p) => p !== null);
  const totalCost = feasible
    ? (plans as WarehousePlan[]).reduce((s, p) => s + p.totalCost, 0)
    : INF;
  return { plans, feasible, totalCost };
}

/** 按给定订单序列模拟执行（用于“旧方案在更正需求下”的费用/可行性评估）。 */
export function simulateOrders(
  wh: WarehouseInput,
  horizon: number,
  orders: { day: number; channel: string; qty: number }[],
): { feasible: boolean; cost: number; days: DayRecord[] } {
  const fixedOf = new Map(wh.channels.map((c) => [c.name, c.fixedCost]));
  const arrivalsByDay = new Map<number, { channel: string; qty: number }[]>();
  let orderingCost = 0;
  for (const o of orders) {
    if (o.day < 0 || o.day >= horizon || o.qty <= 0) continue;
    const list = arrivalsByDay.get(o.day) ?? [];
    list.push({ channel: o.channel, qty: o.qty });
    arrivalsByDay.set(o.day, list);
    orderingCost += fixedOf.get(o.channel) ?? 0;
  }
  const days: DayRecord[] = [];
  let inv = wh.initialInventory;
  let holdingCostTotal = 0;
  let feasible = true;
  for (let t = 0; t < horizon; t++) {
    const arrivals = arrivalsByDay.get(t) ?? [];
    const arrived = arrivals.reduce((s, a) => s + a.qty, 0);
    const end = inv + arrived - wh.demand[t]!;
    if (end < 0 || end > wh.capacity) feasible = false;
    const hold = feasible || end >= 0 ? wh.holdingCost * Math.max(end, 0) : 0;
    holdingCostTotal += hold;
    days.push({
      day: t,
      startInventory: inv,
      arrivals,
      demand: wh.demand[t]!,
      endInventory: end,
      holdingCost: hold,
    });
    inv = end;
  }
  return { feasible, cost: orderingCost + holdingCostTotal, days };
}
