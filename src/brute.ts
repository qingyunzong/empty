/**
 * 独立枚举核对器：与求解器完全不同的实现路径。
 * 枚举每个订单的分配（车辆 0..V-1 或未分配），对每辆车的订单集合
 * 枚举全部排列并正向模拟求最优净收益，最后按 (目标值, 并列编码) 取最优。
 * 仅适用于小规模（订单数建议 <= 8），用于测试交叉验证。
 */
import { ProblemInput, validateInput } from "./types";
import { assignmentKey, decodeAssignmentKey } from "./key";

export interface BruteResult {
  objectiveValue: number;
  assignment: number[];
  key: string;
}

/** 正向模拟一辆车按 seq 顺序服务，返回净收益；不可行返回 -Infinity。 */
function simulate(input: ProblemInput, vi: number, seq: number[]): number {
  const T = input.travelTime;
  const rate = input.emptyCostPerUnitTime;
  const veh = input.vehicles[vi];
  let loc = veh.startPoint;
  let time = veh.availableTime;
  let value = 0;
  for (const oi of seq) {
    const o = input.orders[oi];
    const empty = T[loc][o.pickup];
    const start = Math.max(time + empty, o.readyTime);
    const finish = start + o.serviceTime + T[o.pickup][o.delivery];
    if (finish > o.deadline) return -Infinity;
    value += o.revenue - rate * empty;
    loc = o.delivery;
    time = finish;
  }
  return value;
}

/** 枚举集合的所有排列，求该车服务该集合的最大净收益。 */
function bestPermValue(input: ProblemInput, vi: number, members: number[]): number {
  let best = -Infinity;
  const used = new Array(members.length).fill(false);
  const cur: number[] = [];
  const walk = () => {
    if (cur.length === members.length) {
      const v = simulate(input, vi, cur);
      if (v > best) best = v;
      return;
    }
    for (let i = 0; i < members.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(members[i]);
      walk();
      cur.pop();
      used[i] = false;
    }
  };
  walk();
  return best;
}

export function bruteForceSolve(input: ProblemInput): BruteResult {
  validateInput(input);
  const n = input.orders.length;
  const V = input.vehicles.length;
  const size = 1 << n;

  // 每辆车、每个订单子集的最优净收益（排列枚举 + 缓存）
  const cache: Float64Array[] = [];
  for (let vi = 0; vi < V; vi++) {
    const table = new Float64Array(size).fill(-Infinity);
    table[0] = 0;
    for (let mask = 1; mask < size; mask++) {
      const members: number[] = [];
      for (let i = 0; i < n; i++) if (mask & (1 << i)) members.push(i);
      table[mask] = bestPermValue(input, vi, members);
    }
    cache.push(table);
  }

  let bestValue = -Infinity;
  let bestKey = 0n;
  const assignment = new Array<number>(n).fill(-1);

  // 枚举全部 (V+1)^n 种分配，叶子处按车辆分组求和
  const walk = (i: number) => {
    if (i === n) {
      let value = 0;
      for (let vi = 0; vi < V; vi++) {
        let mask = 0;
        for (let j = 0; j < n; j++) if (assignment[j] === vi) mask |= 1 << j;
        const v = cache[vi][mask];
        if (v === -Infinity) return; // 该车承担的集合不可行
        value += v;
      }
      const key = assignmentKey(assignment, V);
      if (value > bestValue || (value === bestValue && key < bestKey)) {
        bestValue = value;
        bestKey = key;
      }
      return;
    }
    for (let vi = -1; vi < V; vi++) {
      assignment[i] = vi;
      walk(i + 1);
    }
  };
  walk(0);

  if (bestValue === -Infinity) bestValue = 0; // 全不分配恒可行（value 0）
  return {
    objectiveValue: bestValue,
    assignment: decodeAssignmentKey(bestKey, n, V),
    key: bestKey.toString(),
  };
}
