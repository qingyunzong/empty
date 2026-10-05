import type { PlanCertificate, PlanInput, RouteStop, VehicleRoute } from "./types.js";
import { validateInput } from "./validate.js";

/**
 * 独立枚举核对器：不使用 DP，直接枚举
 *   每个订单 -> 车辆 0..V-1 或未分配  (V+1)^n 种分配
 *   x 每辆车订单集合的全部排列
 * 在与求解器相同的规范全序下取最优，用于交叉核对 solvePlan 的结果。
 * 复杂度为指数级，仅适合中小规模（建议 n <= 10）。
 */

function lexCompare(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

interface Cand {
  profit: number;
  assign: number[];
  routes: number[][];
}

function compareCand(a: Cand, b: Cand): number {
  if (a.profit !== b.profit) return a.profit > b.profit ? -1 : 1;
  const c = lexCompare(a.assign, b.assign);
  if (c !== 0) return c;
  const m = Math.min(a.routes.length, b.routes.length);
  for (let i = 0; i < m; i++) {
    const r = lexCompare(a.routes[i], b.routes[i]);
    if (r !== 0) return r;
  }
  return a.routes.length - b.routes.length;
}

/** 模拟一条顺序固定的路线，可行返回总空驶时间，不可行返回 null。 */
function tryRoute(input: PlanInput, v: number, seq: number[]): number | null {
  const vehicle = input.vehicles[v];
  let loc = vehicle.startLocation;
  let time = vehicle.availableTime;
  let empty = 0;
  for (const oi of seq) {
    const o = input.orders[oi];
    const leg = input.emptyTime[loc][o.location];
    const arrival = time + leg;
    const start = Math.max(arrival, o.readyTime);
    if (start > o.dueTime) return null;
    empty += leg;
    time = start + o.duration;
    loc = o.location;
  }
  return empty;
}

interface MaskBest {
  empty: (number | null)[];
  path: (number[] | null)[];
}

/** 对每个订单子集枚举全部排列，求该集合作为单车路线的最小空驶与对应顺序。 */
function bestPermutations(input: PlanInput, v: number): MaskBest {
  const n = input.orders.length;
  const size = 1 << n;
  const empty: (number | null)[] = new Array(size).fill(null);
  const path: (number[] | null)[] = new Array(size).fill(null);
  empty[0] = 0;
  path[0] = [];
  for (let mask = 1; mask < size; mask++) {
    const elems: number[] = [];
    for (let i = 0; i < n; i++) if ((mask & (1 << i)) !== 0) elems.push(i);
    const used = new Array(elems.length).fill(false);
    const cur: number[] = [];
    const visit = (): void => {
      if (cur.length === elems.length) {
        const e = tryRoute(input, v, cur);
        if (
          e !== null &&
          (empty[mask] === null ||
            e < (empty[mask] as number) ||
            (e === empty[mask] && lexCompare(cur, path[mask] as number[]) < 0))
        ) {
          empty[mask] = e;
          path[mask] = cur.slice();
        }
        return;
      }
      for (let i = 0; i < elems.length; i++) {
        if (used[i]) continue;
        used[i] = true;
        cur.push(elems[i]);
        visit();
        cur.pop();
        used[i] = false;
      }
    };
    visit();
  }
  return { empty, path };
}

/** 独立重算时间线并生成证书（与 solver 不共享模拟代码）。 */
function buildCertificate(input: PlanInput, cand: Cand): PlanCertificate {
  const routes: VehicleRoute[] = [];
  let totalRevenue = 0;
  let totalEmptyCost = 0;
  for (let v = 0; v < input.vehicles.length; v++) {
    const vehicle = input.vehicles[v];
    const stops: RouteStop[] = [];
    let loc = vehicle.startLocation;
    let time = vehicle.availableTime;
    let empty = 0;
    let revenue = 0;
    for (const oi of cand.routes[v]) {
      const o = input.orders[oi];
      const leg = input.emptyTime[loc][o.location];
      const arrival = time + leg;
      const start = Math.max(arrival, o.readyTime);
      const completion = start + o.duration;
      stops.push({
        orderIndex: oi,
        orderId: o.id,
        location: o.location,
        emptyTimeFromPrev: leg,
        arrivalTime: arrival,
        startTime: start,
        completionTime: completion,
      });
      empty += leg;
      revenue += o.revenue;
      loc = o.location;
      time = completion;
    }
    const emptyCost = empty * vehicle.costPerUnitTime;
    totalRevenue += revenue;
    totalEmptyCost += emptyCost;
    routes.push({
      vehicleIndex: v,
      vehicleId: vehicle.id,
      stops,
      emptyTime: empty,
      emptyCost,
      revenue,
      profit: revenue - emptyCost,
    });
  }
  const assignment: (number | null)[] = cand.assign.map((a) =>
    a >= input.vehicles.length ? null : a,
  );
  return {
    profit: totalRevenue - totalEmptyCost,
    totalRevenue,
    totalEmptyCost,
    assignment,
    routes,
  };
}

/** 全枚举求最优，返回与 solvePlan 相同规范下的最优证书。 */
export function bruteForcePlan(input: PlanInput): PlanCertificate {
  validateInput(input);
  const n = input.orders.length;
  const V = input.vehicles.length;
  const perms: MaskBest[] = [];
  for (let v = 0; v < V; v++) perms.push(bestPermutations(input, v));

  const vehicleMask = new Array(V).fill(0);
  const vehicleRev = new Array(V).fill(0);
  const assign = new Array(n).fill(V);
  let best: Cand | null = null;

  const dfs = (i: number): void => {
    if (i === n) {
      let profit = 0;
      const routes: number[][] = [];
      for (let v = 0; v < V; v++) {
        if (perms[v].path[vehicleMask[v]] === null) return; // 该车分到的集合不可行
        profit += vehicleRev[v] - input.vehicles[v].costPerUnitTime * (perms[v].empty[vehicleMask[v]] as number);
        routes.push(perms[v].path[vehicleMask[v]] as number[]);
      }
      const cand: Cand = { profit, assign: assign.slice(), routes };
      if (best === null || compareCand(cand, best) < 0) best = cand;
      return;
    }
    for (let v = 0; v < V; v++) {
      // 注意：不能因子集暂不可行而剪枝——非对称空驶矩阵下，
      // 加入更多订单（绕行）可能使原本不可行的集合变得可行。
      const newMask = vehicleMask[v] | (1 << i);
      const prevMask = vehicleMask[v];
      vehicleMask[v] = newMask;
      vehicleRev[v] += input.orders[i].revenue;
      assign[i] = v;
      dfs(i + 1);
      assign[i] = V;
      vehicleRev[v] -= input.orders[i].revenue;
      vehicleMask[v] = prevMask;
    }
    dfs(i + 1); // 订单不分配
  };
  dfs(0);

  if (best === null) throw new Error("unreachable: enumeration always yields a candidate");
  return buildCertificate(input, best);
}
