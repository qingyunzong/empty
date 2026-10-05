import type { PlanCertificate, PlanInput } from "../src/index.js";

/** 确定性伪随机数发生器（mulberry32），保证测试可复现。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 生成全整数随机算例（整数保证浮点比较精确）。 */
export function randomInstance(rand: () => number, n: number, vehicleCount: number): PlanInput {
  const locCount = 2 + Math.floor(rand() * 4);
  const emptyTime: number[][] = [];
  for (let i = 0; i < locCount; i++) {
    const row: number[] = [];
    for (let j = 0; j < locCount; j++) row.push(i === j ? 0 : 1 + Math.floor(rand() * 9));
    emptyTime.push(row);
  }
  const orders = [];
  for (let i = 0; i < n; i++) {
    const ready = Math.floor(rand() * 20);
    const wide = rand() < 0.2;
    orders.push({
      id: `o${i}`,
      location: Math.floor(rand() * locCount),
      readyTime: ready,
      dueTime: wide ? Infinity : ready + Math.floor(rand() * 25),
      duration: 1 + Math.floor(rand() * 5),
      revenue: 1 + Math.floor(rand() * 20),
    });
  }
  const vehicles = [];
  for (let v = 0; v < vehicleCount; v++) {
    vehicles.push({
      id: `v${v}`,
      startLocation: Math.floor(rand() * locCount),
      availableTime: Math.floor(rand() * 6),
      costPerUnitTime: Math.floor(rand() * 3),
    });
  }
  return { orders, vehicles, emptyTime };
}

/** 规范化证书用于等价比较（忽略派生字段，保留决定解的内容）。 */
export function normalize(cert: PlanCertificate): unknown {
  return {
    profit: cert.profit,
    totalRevenue: cert.totalRevenue,
    totalEmptyCost: cert.totalEmptyCost,
    assignment: cert.assignment,
    routes: cert.routes.map((r) => r.stops.map((s) => s.orderIndex)),
  };
}
