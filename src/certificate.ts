import { simulateOrders } from "./solver.js";
import type { Optimum } from "./verify.js";
import type { WarehouseInput, WarehousePlan } from "./types.js";

const pad = (s: string, n: number): string => s.padStart(n, " ");
const CHECK = "✓";
const CROSS = "✗";

export interface RenderOptions {
  replan: boolean;
  violations: string[]; // checkCertificate 结果
  crossCheck: Optimum | null; // 独立有限状态搜索结果
  enumeration?: (Optimum & { explored: number }) | null; // 短周期枚举（可选）
}

/** 逐日库存证书。 */
export function renderCertificate(
  wh: WarehouseInput,
  horizon: number,
  plan: WarehousePlan,
  opts: RenderOptions,
): string {
  const L: string[] = [];
  const chDesc = wh.channels
    .map((c) => `${c.name}(提前期${c.leadTime}, 启单费${c.fixedCost})`)
    .join("  ");
  L.push(`── 仓库 ${wh.id} ｜ 规划期 ${horizon} 天 ｜ 仓容 ${wh.capacity} ｜ 持有费 ${wh.holdingCost}/件/天`);
  L.push(`   渠道: ${chDesc}`);
  L.push(`   日 | 期初 | 到货            | 需求 | 期末 | 持有费 | 守恒`);
  for (const d of plan.days) {
    const arr =
      d.arrivals.length === 0
        ? "-"
        : d.arrivals.map((a) => `${a.channel}:${a.qty}`).join("+");
    const balanced = d.startInventory + d.arrivals.reduce((s, a) => s + a.qty, 0) - d.demand === d.endInventory;
    L.push(
      `  ${pad(String(d.day), 2)} | ${pad(String(d.startInventory), 4)} | ${arr.padEnd(15)} | ${pad(String(d.demand), 4)} | ${pad(String(d.endInventory), 4)} | ${pad(String(d.holdingCost), 6)} | ${balanced ? CHECK : CROSS}`,
    );
  }
  if (plan.orders.length > 0) {
    L.push(`   订单明细（到货日 ← 下单日）:`);
    for (const o of plan.orders) {
      const src = o.placeDay < 0 ? `第${o.placeDay}天(窗口前已发出,在途)` : `第${o.placeDay}天`;
      L.push(`     第${o.day}天 经 ${o.channel} 到货 ${o.qty} 件 ← ${src}下单`);
    }
  } else {
    L.push(`   订单明细: 无（全程由期初库存覆盖）`);
  }
  L.push(
    `   费用: 启单费 ${plan.orderingCost} + 持有费 ${plan.holdingCostTotal} = 总费 ${plan.totalCost}` +
      (opts.replan ? ` ｜ 已公布下单量总偏差 ${plan.deviation}` : ""),
  );
  const balancedAll = plan.days.every(
    (d) => d.startInventory + d.arrivals.reduce((s, a) => s + a.qty, 0) - d.demand === d.endInventory,
  );
  const checks: string[] = [
    `逐日守恒 ${balancedAll ? CHECK : CROSS}`,
    `证书校验 ${opts.violations.length === 0 ? CHECK : CROSS + " " + opts.violations.join("；")}`,
  ];
  if (opts.crossCheck) {
    const match =
      opts.crossCheck.cost === plan.totalCost &&
      (!opts.replan || opts.crossCheck.dev === plan.deviation);
    checks.push(
      `独立有限状态搜索 ${match ? CHECK : CROSS} (dev=${opts.crossCheck.dev}, cost=${opts.crossCheck.cost})`,
    );
  } else {
    checks.push(`独立有限状态搜索: 不可行`);
  }
  if (opts.enumeration) {
    const match =
      opts.enumeration.cost === plan.totalCost &&
      (!opts.replan || opts.enumeration.dev === plan.deviation);
    checks.push(
      `短周期枚举 ${match ? CHECK : CROSS} (dev=${opts.enumeration.dev}, cost=${opts.enumeration.cost}, 枚举 ${opts.enumeration.explored} 个完整计划)`,
    );
  }
  L.push(`   核对: ${checks.join(" ｜ ")}`);
  return L.join("\n");
}

/** 重规划净差：逐槽位 已公布 → 新计划，以及旧方案在更正需求下的费用对照。 */
export function renderReplanDiff(
  wh: WarehouseInput,
  horizon: number,
  plan: WarehousePlan,
): string {
  const L: string[] = [];
  L.push(`── 重规划净差 ｜ 仓库 ${wh.id}`);
  const published = wh.published ?? [];
  const newQty = new Map<string, number>();
  for (const o of plan.orders) {
    const k = `${o.day}|${o.channel}`;
    newQty.set(k, (newQty.get(k) ?? 0) + o.qty);
  }
  const keys = new Set<string>([
    ...published.filter((o) => o.day >= 0 && o.day < horizon).map((o) => `${o.day}|${o.channel}`),
    ...newQty.keys(),
  ]);
  const oldQty = new Map<string, number>();
  for (const o of published) {
    if (o.day < 0 || o.day >= horizon) continue;
    const k = `${o.day}|${o.channel}`;
    oldQty.set(k, (oldQty.get(k) ?? 0) + o.qty);
  }
  let absDelta = 0;
  let netDelta = 0;
  L.push(`   到货日/渠道        已公布 → 新计划    Δ`);
  for (const k of [...keys].sort()) {
    const [day, channel] = k.split("|");
    const before = oldQty.get(k) ?? 0;
    const after = newQty.get(k) ?? 0;
    const delta = after - before;
    absDelta += Math.abs(delta);
    netDelta += delta;
    if (delta === 0 && before === 0) continue;
    const tag = delta === 0 ? "保持" : after > before ? "新增/加单" : after === 0 ? "撤销" : "撤销未锁定部分";
    L.push(
      `   第${pad(String(day), 2)}天 ${channel.padEnd(10)} ${pad(String(before), 4)} → ${pad(String(after), 4)}   ${delta >= 0 ? "+" : ""}${delta}  (${tag})`,
    );
  }
  L.push(`   下单量调整量 |Δ| 合计 ${absDelta} ｜ 净变化 ${netDelta >= 0 ? "+" : ""}${netDelta}`);

  const oldOrders = published.map((o) => ({ day: o.day, channel: o.channel, qty: o.qty }));
  const oldEval = simulateOrders(wh, horizon, oldOrders);
  const oldCost = oldEval.feasible ? String(oldEval.cost) : "不可行(缺货/超容)";
  const deltaCost = oldEval.feasible ? plan.totalCost - oldEval.cost : null;
  L.push(
    `   费用对照(更正后需求): 沿用已公布方案 ${oldCost} → 重规划 ${plan.totalCost}` +
      (deltaCost !== null ? ` (Δ ${deltaCost >= 0 ? "+" : ""}${deltaCost})` : ""),
  );
  const balanceMarks = plan.days
    .map((d) =>
      d.startInventory + d.arrivals.reduce((s, a) => s + a.qty, 0) - d.demand === d.endInventory
        ? CHECK
        : CROSS,
    )
    .join("");
  L.push(`   逐日守恒: ${balanceMarks}`);
  return L.join("\n");
}
