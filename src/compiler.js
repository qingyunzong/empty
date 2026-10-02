// 约束编译为字节码：负荷累加、容量/维护断言、费用/碳排/峰值统计
export const OPS = Object.freeze({
  ADD: 'ADD',       // { slots, power } 在若干 15 分钟槽上累加功率
  ZERO: 'ZERO',     // { slots } 断言这些槽负荷为 0（维护窗）
  CAP: 'CAP',       // { cap } 断言所有槽负荷不超过容量
  COST: 'COST',     // { table } 按电价表累计电费
  CARBON: 'CARBON', // { table } 按碳强度表累计碳排
  PEAK: 'PEAK',     // 计算峰值
  HALT: 'HALT',
});

// 单个任务摆放 -> 计算其费用/碳排的小程序
export function compilePlacement(task, slots, spec) {
  return [
    { op: OPS.ADD, slots, power: task.power },
    { op: OPS.COST, table: spec.prices },
    { op: OPS.CARBON, table: spec.carbonIntensity },
    { op: OPS.HALT },
  ];
}

// 完整方案 -> 含全部硬约束断言与统计的程序
export function compilePlan(spec, schedule) {
  const byId = new Map(spec.tasks.map((t) => [t.id, t]));
  const ops = [];
  for (const item of schedule) {
    const t = byId.get(item.task);
    if (!t) throw new Error(`编译失败：未知任务 "${item.task}"`);
    ops.push({ op: OPS.ADD, slots: item.slots, power: t.power });
  }
  if (spec.maintenance.length > 0) ops.push({ op: OPS.ZERO, slots: spec.maintenance });
  if (spec.capacity !== Infinity) ops.push({ op: OPS.CAP, cap: spec.capacity });
  ops.push({ op: OPS.COST, table: spec.prices });
  ops.push({ op: OPS.CARBON, table: spec.carbonIntensity });
  ops.push({ op: OPS.PEAK });
  ops.push({ op: OPS.HALT });
  return ops;
}
