import type { PlanCertificate, PlanInput, VehicleRoute } from "./types.js";
import { validateInput } from "./validate.js";
import { simulateRoute } from "./simulate.js";

/**
 * 规范全序（并列时按订单分配序）：
 * 1. 利润（总收益 - 总空驶费）高者优先；
 * 2. 分配向量按订单输入序字典序小者优先（元素为车辆下标，未分配 = 车辆数，
 *    即"已分给小号车"优于"未分配"）；
 * 3. 各车路线（订单下标序列）按车辆序号依次字典序小者优先。
 */

interface PathState {
  completion: number;
  empty: number;
  path: number[];
}

function lexCompare(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/**
 * a 支配 b：完成时刻不劣，且
 *   - 空驶严格更小（b 的任何延伸都被 a 的同名延伸以更小空驶匹配）；或
 *   - 空驶相等且路径字典序不劣（延伸相同后缀后 a 的完整路线仍不劣于 b）。
 * 空驶相等但路径字典序更大时不构成支配，否则并列时会丢失字典序最小路线。
 */
function dominates(a: PathState, b: PathState): boolean {
  if (a.completion > b.completion) return false;
  if (a.empty < b.empty) return true;
  if (a.empty > b.empty) return false;
  return lexCompare(a.path, b.path) <= 0;
}

function insertPareto(set: PathState[], st: PathState): void {
  for (const e of set) {
    if (dominates(e, st)) return;
  }
  let w = 0;
  for (const e of set) {
    if (!dominates(st, e)) set[w++] = e;
  }
  set.length = w;
  set.push(st);
}

interface Combo {
  profit: number;
  assign: number[];
  routes: number[][];
}

function compareRoutes(a: number[][], b: number[][]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = lexCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** 返回负数表示 a 优于 b。 */
function compareCombo(a: Combo, b: Combo): number {
  if (a.profit !== b.profit) return a.profit > b.profit ? -1 : 1;
  const c = lexCompare(a.assign, b.assign);
  if (c !== 0) return c;
  return compareRoutes(a.routes, b.routes);
}

interface VehicleTable {
  /** path[mask]：单车恰好服务 mask 中订单的最优顺序（空驶最小，并列取字典序最小）；不可行为 null。 */
  path: (number[] | null)[];
  empty: Float64Array;
}

/** 单车子集 DP：状态 (mask, last) 上维护 (完成时刻, 空驶) 的帕累托前沿。 */
function buildVehicleTable(input: PlanInput, v: number): VehicleTable {
  const n = input.orders.length;
  const size = 1 << n;
  const vehicle = input.vehicles[v];
  const orders = input.orders;
  const T = input.emptyTime;
  const pareto: (PathState[] | undefined)[] = new Array(size * n);
  const setAt = (mask: number, last: number): PathState[] => {
    const idx = mask * n + last;
    let s = pareto[idx];
    if (s === undefined) s = pareto[idx] = [];
    return s;
  };
  for (let j = 0; j < n; j++) {
    const o = orders[j];
    const leg = T[vehicle.startLocation][o.location];
    const arrival = vehicle.availableTime + leg;
    const start = Math.max(arrival, o.readyTime);
    if (start > o.dueTime) continue;
    insertPareto(setAt(1 << j, j), { completion: start + o.duration, empty: leg, path: [j] });
  }
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      if ((mask & (1 << last)) === 0) continue;
      const set = pareto[mask * n + last];
      if (set === undefined || set.length === 0) continue;
      const fromLoc = orders[last].location;
      for (const st of set) {
        for (let nxt = 0; nxt < n; nxt++) {
          if ((mask & (1 << nxt)) !== 0) continue;
          const o = orders[nxt];
          const leg = T[fromLoc][o.location];
          const arrival = st.completion + leg;
          const start = Math.max(arrival, o.readyTime);
          if (start > o.dueTime) continue;
          insertPareto(setAt(mask | (1 << nxt), nxt), {
            completion: start + o.duration,
            empty: st.empty + leg,
            path: [...st.path, nxt],
          });
        }
      }
    }
  }
  const path: (number[] | null)[] = new Array(size).fill(null);
  const empty = new Float64Array(size).fill(NaN);
  path[0] = [];
  empty[0] = 0;
  for (let mask = 1; mask < size; mask++) {
    let bestEmpty = Infinity;
    let bestPath: number[] | null = null;
    for (let last = 0; last < n; last++) {
      if ((mask & (1 << last)) === 0) continue;
      const set = pareto[mask * n + last];
      if (set === undefined) continue;
      for (const st of set) {
        if (
          st.empty < bestEmpty ||
          (st.empty === bestEmpty && bestPath !== null && lexCompare(st.path, bestPath) < 0)
        ) {
          bestEmpty = st.empty;
          bestPath = st.path;
        }
      }
    }
    if (bestPath !== null) {
      path[mask] = bestPath;
      empty[mask] = bestEmpty;
    }
  }
  return { path, empty };
}

function buildCertificate(input: PlanInput, combo: Combo): PlanCertificate {
  const routes: VehicleRoute[] = [];
  let totalRevenue = 0;
  let totalEmptyCost = 0;
  for (let v = 0; v < input.vehicles.length; v++) {
    const vehicle = input.vehicles[v];
    const sim = simulateRoute(input, v, combo.routes[v]);
    const emptyCost = sim.emptyTime * vehicle.costPerUnitTime;
    totalRevenue += sim.revenue;
    totalEmptyCost += emptyCost;
    routes.push({
      vehicleIndex: v,
      vehicleId: vehicle.id,
      stops: sim.stops,
      emptyTime: sim.emptyTime,
      emptyCost,
      revenue: sim.revenue,
      profit: sim.revenue - emptyCost,
    });
  }
  const assignment: (number | null)[] = combo.assign.map((a) =>
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

/** 精确求解：返回规范全序下的最优路线证书。 */
export function solvePlan(input: PlanInput): PlanCertificate {
  validateInput(input);
  const n = input.orders.length;
  const V = input.vehicles.length;
  const size = 1 << n;
  const rev = new Float64Array(size);
  for (let mask = 1; mask < size; mask++) {
    const lsb = mask & -mask;
    rev[mask] = rev[mask ^ lsb] + input.orders[31 - Math.clz32(lsb)].revenue;
  }
  const tables: VehicleTable[] = [];
  for (let v = 0; v < V; v++) tables.push(buildVehicleTable(input, v));

  const UNASSIGNED = V;
  let g: (Combo | null)[] = new Array(size).fill(null);
  g[0] = { profit: 0, assign: new Array(n).fill(UNASSIGNED), routes: [] };

  for (let v = 0; v < V; v++) {
    const rate = input.vehicles[v].costPerUnitTime;
    const table = tables[v];
    const next: (Combo | null)[] = new Array(size).fill(null);
    for (let mask = 0; mask < size; mask++) {
      let best: Combo | null = null;
      for (let sub = mask; ; sub = (sub - 1) & mask) {
        const prev = g[mask ^ sub];
        const subPath = table.path[sub];
        if (prev !== null && subPath !== null) {
          const profit = prev.profit + rev[sub] - rate * table.empty[sub];
          if (best === null || profit >= best.profit) {
            const assign = prev.assign.slice();
            let m = sub;
            while (m !== 0) {
              const lsb = m & -m;
              assign[31 - Math.clz32(lsb)] = v;
              m ^= lsb;
            }
            const cand: Combo = { profit, assign, routes: [...prev.routes, subPath] };
            if (best === null || compareCombo(cand, best) < 0) best = cand;
          }
        }
        if (sub === 0) break;
      }
      next[mask] = best;
    }
    g = next;
  }

  let best: Combo | null = null;
  for (let mask = 0; mask < size; mask++) {
    const c = g[mask];
    if (c !== null && (best === null || compareCombo(c, best) < 0)) best = c;
  }
  return buildCertificate(input, best as Combo);
}
