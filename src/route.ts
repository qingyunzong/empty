import { EPS, type CertLeg, type Instance } from "./types.js";

export interface Simulation {
  feasible: boolean;
  legs: CertLeg[];
  profit: number;
  /** 纯行驶路程（含返回基地） */
  distance: number;
  /** 总耗时 = 行驶 + 等待 + 服务，含返回基地 */
  totalTime: number;
}

/**
 * 模拟一条访问顺序（站点下标 1..n）：从基地 0 时刻出发，最后返回基地。
 * 规则：到达早于 open 则等待；开始服务晚于 close 则不可行；总耗时须 <= timeLimit。
 */
export function simulateRoute(inst: Instance, order: number[]): Simulation {
  const legs: CertLeg[] = [{ node: inst.ids[0]!, arrive: 0, wait: 0, start: 0, depart: 0 }];
  let t = 0;
  let distance = 0;
  let profit = 0;
  let prev = 0;
  let feasible = true;

  for (const s of order) {
    const legDist = inst.dist[prev]![s]!;
    distance += legDist;
    const arrive = t + legDist;
    const start = Math.max(arrive, inst.open[s]!);
    if (start > inst.close[s]! + EPS) {
      feasible = false;
      break;
    }
    const depart = start + inst.service[s]!;
    legs.push({
      node: inst.ids[s]!,
      arrive,
      wait: start - arrive,
      start,
      depart,
      window: [inst.open[s]!, inst.close[s]!],
      service: inst.service[s]!,
      profit: inst.profit[s]!,
    });
    profit += inst.profit[s]!;
    t = depart;
    prev = s;
  }

  const backDist = inst.dist[prev]![0]!;
  distance += backDist;
  const totalTime = t + backDist;
  legs.push({ node: inst.ids[0]!, arrive: totalTime, wait: 0, start: totalTime, depart: totalTime });
  if (totalTime > inst.timeLimit + EPS) feasible = false;

  return { feasible, legs, profit, distance, totalTime };
}

/** 目标比较：收益大者优先；并列时路程小者优先；再并列时总耗时小者优先。 */
export function better(
  a: { profit: number; distance: number; totalTime: number },
  b: { profit: number; distance: number; totalTime: number },
): boolean {
  if (a.profit !== b.profit) return a.profit > b.profit;
  if (Math.abs(a.distance - b.distance) > EPS) return a.distance < b.distance;
  return a.totalTime < b.totalTime - EPS;
}
