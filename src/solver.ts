/**
 * 精确求解器。
 *
 * 第一阶段（每辆车）：子集 DP。状态 (S, i) 表示某车恰好服务订单集合 S
 * 且最后一单为 i；每个状态保存 (完成时刻, 净收益) 的 Pareto 前沿
 * （时刻小且收益高者占优），保证时间窗可行性不被贪心破坏。
 *
 * 第二阶段（车辆组合）：f[v][S] 表示前 v 辆车恰好覆盖订单集合 S 的
 * 最优 (目标值, 并列编码)。目标值与编码对子集均可加，按字典序取最大，
 * 因此可以分解合并。最终对所有 S 取 max，未分配订单按编码 V 计入。
 */
import { ProblemInput, validateInput } from "./types";
import { assignmentKey } from "./key";

export interface RouteStop {
  orderId: string;
  orderIndex: number;
  pickup: number;
  delivery: number;
  /** 从上一位置（车辆初始点或上一单送货点）空驶到本单取货点的时间 */
  emptyTravelFromPrev: number;
  arrivePickup: number;
  startService: number;
  departPickup: number;
  arriveDelivery: number;
}

export interface VehicleRoute {
  vehicleId: string;
  vehicleIndex: number;
  startPoint: number;
  departTime: number;
  stops: RouteStop[];
  finishTime: number;
  emptyTravelTime: number;
  revenue: number;
}

/** 路线证书：可被 verifyCertificate 独立模拟核对 */
export interface Certificate {
  objectiveValue: number;
  totalRevenue: number;
  totalEmptyTravelTime: number;
  totalEmptyCost: number;
  /** assignment[i] = 订单 i 分到的车辆下标，-1 表示未分配 */
  assignment: number[];
  routes: VehicleRoute[];
  unassigned: string[];
}

interface FrontierEntry {
  time: number;
  value: number;
  parentMask: number;
  parentLast: number; // -1 表示由车辆起点出发的首单
  parentIdx: number;
}

interface VehicleTable {
  /** bestValue[mask]：该车恰好服务 mask 的最大净收益，不可行为 -Infinity */
  bestValue: Float64Array;
  /** choice[mask]：取得最优时的 (last, 前沿下标)，用于回溯路线 */
  choiceLast: Int32Array;
  choiceIdx: Int32Array;
  /** frontiers[mask * n + last]：Pareto 前沿（已剪枝，按 time 升序、value 严格升序） */
  frontiers: (FrontierEntry[] | undefined)[];
}

const NEG = -Infinity;

function pruneFrontier(list: FrontierEntry[]): FrontierEntry[] {
  list.sort((a, b) => (a.time - b.time) || (b.value - a.value));
  const kept: FrontierEntry[] = [];
  let bestValue = NEG;
  for (const e of list) {
    if (e.value > bestValue) {
      kept.push(e);
      bestValue = e.value;
    }
  }
  return kept;
}

/** 构建单辆车的子集 DP 表。 */
function buildVehicleTable(input: ProblemInput, vi: number): VehicleTable {
  const n = input.orders.length;
  const size = 1 << n;
  const T = input.travelTime;
  const rate = input.emptyCostPerUnitTime;
  const veh = input.vehicles[vi];
  const orders = input.orders;

  const frontiers: (FrontierEntry[] | undefined)[] = new Array(size * n);

  // 首单：从车辆初始点出发
  for (let i = 0; i < n; i++) {
    const o = orders[i];
    const empty = T[veh.startPoint][o.pickup];
    const start = Math.max(veh.availableTime + empty, o.readyTime);
    const finish = start + o.serviceTime + T[o.pickup][o.delivery];
    if (finish <= o.deadline) {
      const mask = 1 << i;
      const slot = mask * n + i;
      (frontiers[slot] ??= []).push({
        time: finish,
        value: o.revenue - rate * empty,
        parentMask: 0,
        parentLast: -1,
        parentIdx: -1,
      });
    }
  }

  // 子集 DP：按 mask 递增，子集必先于超集处理
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const raw = frontiers[mask * n + last];
      if (!raw || raw.length === 0) continue;
      const pruned = pruneFrontier(raw);
      frontiers[mask * n + last] = pruned;
      const prevDelivery = orders[last].delivery;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const o = orders[j];
        const empty = T[prevDelivery][o.pickup];
        const haul = T[o.pickup][o.delivery];
        const nmask = mask | (1 << j);
        const slot = nmask * n + j;
        let list = frontiers[slot];
        for (let k = 0; k < pruned.length; k++) {
          const e = pruned[k];
          const start = Math.max(e.time + empty, o.readyTime);
          const finish = start + o.serviceTime + haul;
          if (finish > o.deadline) continue;
          if (!list) list = frontiers[slot] = [];
          list.push({
            time: finish,
            value: e.value + o.revenue - rate * empty,
            parentMask: mask,
            parentLast: last,
            parentIdx: k,
          });
        }
      }
    }
  }

  const bestValue = new Float64Array(size).fill(NEG);
  bestValue[0] = 0;
  const choiceLast = new Int32Array(size).fill(-1);
  const choiceIdx = new Int32Array(size).fill(-1);
  for (let mask = 1; mask < size; mask++) {
    let best = NEG;
    let bl = -1;
    let bi = -1;
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const list = frontiers[mask * n + last];
      if (!list || list.length === 0) continue;
      // 已剪枝前沿的最后一项收益最大
      const idx = list.length - 1;
      const v = list[idx].value;
      if (v > best) {
        best = v;
        bl = last;
        bi = idx;
      }
    }
    bestValue[mask] = best;
    choiceLast[mask] = bl;
    choiceIdx[mask] = bi;
  }
  return { bestValue, choiceLast, choiceIdx, frontiers };
}

/** 回溯车辆 vi 服务 mask 的订单序列（按服务顺序返回订单下标）。 */
function reconstructOrderSequence(
  table: VehicleTable,
  n: number,
  mask: number,
): number[] {
  const seq: number[] = [];
  let m = mask;
  let last = table.choiceLast[m];
  let idx = table.choiceIdx[m];
  while (m !== 0) {
    seq.push(last);
    const e = table.frontiers[m * n + last]![idx];
    m = e.parentMask;
    if (m === 0) break;
    idx = e.parentIdx;
    last = e.parentLast;
  }
  seq.reverse();
  return seq;
}

/** 按证书格式正向模拟一辆车服务给定订单序列，生成路线。 */
function buildRoute(input: ProblemInput, vi: number, seq: number[]): VehicleRoute {
  const veh = input.vehicles[vi];
  const T = input.travelTime;
  const stops: RouteStop[] = [];
  let loc = veh.startPoint;
  let time = veh.availableTime;
  let emptyTotal = 0;
  let revenue = 0;
  for (const oi of seq) {
    const o = input.orders[oi];
    const empty = T[loc][o.pickup];
    const arrivePickup = time + empty;
    const startService = Math.max(arrivePickup, o.readyTime);
    const departPickup = startService + o.serviceTime;
    const arriveDelivery = departPickup + T[o.pickup][o.delivery];
    stops.push({
      orderId: o.id,
      orderIndex: oi,
      pickup: o.pickup,
      delivery: o.delivery,
      emptyTravelFromPrev: empty,
      arrivePickup,
      startService,
      departPickup,
      arriveDelivery,
    });
    emptyTotal += empty;
    revenue += o.revenue;
    loc = o.delivery;
    time = arriveDelivery;
  }
  return {
    vehicleId: veh.id,
    vehicleIndex: vi,
    startPoint: veh.startPoint,
    departTime: veh.availableTime,
    stops,
    finishTime: time,
    emptyTravelTime: emptyTotal,
    revenue,
  };
}

/** 精确求解，输出路线证书。 */
export function solve(input: ProblemInput): Certificate {
  validateInput(input);
  const n = input.orders.length;
  const V = input.vehicles.length;
  const size = 1 << n;
  const full = size - 1;

  const assignment = new Array<number>(n).fill(-1);
  if (V === 0 || n === 0) {
    return {
      objectiveValue: 0,
      totalRevenue: 0,
      totalEmptyTravelTime: 0,
      totalEmptyCost: 0,
      assignment,
      routes: [],
      unassigned: input.orders.map((o) => o.id),
    };
  }

  const tables: VehicleTable[] = [];
  for (let vi = 0; vi < V; vi++) tables.push(buildVehicleTable(input, vi));

  // 并列编码的位权：订单 0 为最高位
  const base = BigInt(V + 1);
  const weight = new Array<bigint>(n);
  weight[n - 1] = 1n;
  for (let i = n - 2; i >= 0; i--) weight[i] = weight[i + 1] * base;
  const subsetKey = new Array<bigint>(size).fill(0n);
  for (let mask = 1; mask < size; mask++) {
    const lsb = mask & -mask;
    const bit = 31 - Math.clz32(lsb);
    subsetKey[mask] = subsetKey[mask ^ lsb] + weight[bit];
  }

  interface Cell {
    value: number;
    key: bigint;
    take: number; // 本车承担的子集 T
  }
  // f[S]：已处理的车辆恰好覆盖 S 的最优 (value, key)
  let cur: (Cell | null)[] = new Array(size).fill(null);
  cur[0] = { value: 0, key: 0n, take: 0 };
  const layers: (Cell | null)[][] = [cur];

  for (let vi = 0; vi < V; vi++) {
    const g = tables[vi].bestValue;
    const next: (Cell | null)[] = new Array(size).fill(null);
    const viBig = BigInt(vi);
    for (let S = 0; S < size; S++) {
      let best: Cell | null = null;
      for (let Tsub = S; ; Tsub = (Tsub - 1) & S) {
        const gv = g[Tsub];
        const prev = cur[S ^ Tsub];
        if (prev !== null && gv !== NEG) {
          const value = prev.value + gv;
          const key = prev.key + viBig * subsetKey[Tsub];
          if (
            best === null ||
            value > best.value ||
            (value === best.value && key < best.key)
          ) {
            best = { value, key, take: Tsub };
          }
        }
        if (Tsub === 0) break;
      }
      next[S] = best;
    }
    cur = next;
    layers.push(cur);
  }

  // 收尾：未分配订单按编码 V 计入，取 (value, key) 字典序最大/小
  let bestS = -1;
  let bestValue = NEG;
  let bestKey = 0n;
  const vBig = BigInt(V);
  for (let S = 0; S < size; S++) {
    const c = cur[S];
    if (c === null) continue;
    const key = c.key + vBig * (subsetKey[full] - subsetKey[S]);
    if (bestS === -1 || c.value > bestValue || (c.value === bestValue && key < bestKey)) {
      bestS = S;
      bestValue = c.value;
      bestKey = key;
    }
  }

  // 回溯每辆车承担的子集
  const take = new Array<number>(V).fill(0);
  let S = bestS;
  for (let vi = V - 1; vi >= 0; vi--) {
    const cell = layers[vi + 1][S]!;
    take[vi] = cell.take;
    S ^= cell.take;
  }

  const routes: VehicleRoute[] = [];
  const unassigned: string[] = [];
  let totalRevenue = 0;
  let totalEmpty = 0;
  for (let vi = 0; vi < V; vi++) {
    if (take[vi] === 0) continue;
    const seq = reconstructOrderSequence(tables[vi], n, take[vi]);
    const route = buildRoute(input, vi, seq);
    routes.push(route);
    totalRevenue += route.revenue;
    totalEmpty += route.emptyTravelTime;
    for (const s of route.stops) assignment[s.orderIndex] = vi;
  }
  for (let i = 0; i < n; i++) if (assignment[i] === -1) unassigned.push(input.orders[i].id);

  const totalEmptyCost = totalEmpty * input.emptyCostPerUnitTime;
  return {
    objectiveValue: totalRevenue - totalEmptyCost,
    totalRevenue,
    totalEmptyTravelTime: totalEmpty,
    totalEmptyCost,
    assignment,
    routes,
    unassigned,
  };
}
