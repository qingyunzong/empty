// 精确求解器：两级整数 DP。
// 第一级：每个渠道内部做 (花费, 截断曝光) -> 最大收益 的 DP，并提取帕累托前沿；
// 第二级：跨渠道合并前沿，状态为 (总成本, 截断曝光) -> 最大收益。
// 收益最大为目标，并列时总成本最低；全部整数运算，结果精确最优。
import type { PlanInput, Solution, Allocation, AdGroup } from './model.js';
import { hashValue } from './util.js';

interface LayerNode {
  parent: number; // 上一层节点下标，-1 表示根
  quantity: number; // 本层广告组投放量（渠道内 DP）或渠道序号（全局合并）
  revenue: number; // 累计收益
}

interface ParetoPoint {
  cost: number; // 渠道内花费（或全局总成本）
  exposure: number; // 截断到下限的曝光
  revenue: number;
  nodeIdx: number; // 对应层节点，供回溯
}

interface ChannelFrontier {
  points: ParetoPoint[];
  nodes: LayerNode[]; // 该渠道全部层节点（回溯用）
  groups: AdGroup[]; // 该渠道的广告组（顺序与 nodes 层一致）
  groupIndices: number[]; // 原输入中的广告组下标
}

const STATE_LIMIT = 20_000_000; // 防御性上限，超出时报错而非耗尽内存

export function solve(input: PlanInput): Solution {
  const { channels, exposureLowerBound: cap, groups } = input;

  // 第一级：逐渠道 DP。
  const frontiers: ChannelFrontier[] = channels.map((ch) => {
    const groupIndices: number[] = [];
    const channelGroups: AdGroup[] = [];
    groups.forEach((g, gi) => {
      if (g.channel === ch.id) {
        groupIndices.push(gi);
        channelGroups.push(g);
      }
    });
    return solveChannel(channelGroups, groupIndices, ch.budget, cap);
  });

  // 第二级：跨渠道合并。状态 key = 总成本 * (cap+1) + 截断曝光。
  let statesExplored = frontiers.reduce((sum, f) => sum + f.nodes.length, 0);
  const globalNodes: LayerNode[] = [{ parent: -1, quantity: -1, revenue: 0 }];
  let frontier: ParetoPoint[] = [{ cost: 0, exposure: 0, revenue: 0, nodeIdx: 0 }];
  for (let ci = 0; ci < frontiers.length; ci++) {
    const merged = new Map<number, ParetoPoint>();
    for (const base of frontier) {
      for (const p of frontiers[ci].points) {
        const cost = base.cost + p.cost;
        const exposure = Math.min(cap, base.exposure + p.exposure);
        const revenue = base.revenue + p.revenue;
        const key = cost * (cap + 1) + exposure;
        const existing = merged.get(key);
        if (existing === undefined || revenue > existing.revenue) {
          globalNodes.push({ parent: base.nodeIdx, quantity: p.nodeIdx, revenue });
          merged.set(key, { cost, exposure, revenue, nodeIdx: globalNodes.length - 1 });
          statesExplored++;
        }
      }
    }
    if (merged.size > STATE_LIMIT) throw new Error(`状态空间超过上限 ${STATE_LIMIT}`);
    frontier = paretoPrune([...merged.values()], cap);
  }

  // 终选：曝光达标（截断后等于下限）中收益最大，并列成本最低。
  let best: ParetoPoint | null = null;
  for (const p of frontier) {
    if (p.exposure < cap) continue;
    if (best === null || p.revenue > best.revenue || (p.revenue === best.revenue && p.cost < best.cost)) {
      best = p;
    }
  }

  const frontierHash = hashValue(
    frontier
      .map((p) => ({ cost: p.cost, exposure: p.exposure, revenue: p.revenue }))
      .sort((a, b) => a.cost - b.cost || a.exposure - b.exposure),
  );

  if (best === null) {
    return {
      status: 'infeasible',
      quantities: [],
      allocations: [],
      totalRevenue: 0,
      totalCost: 0,
      totalExposure: 0,
      channelSpend: Object.fromEntries(channels.map((c) => [c.id, 0])),
      statesExplored,
      frontierHash,
    };
  }

  // 回溯：全局节点 -> 各渠道所选前沿点 -> 渠道内逐组投放量。
  const quantities = new Array<number>(groups.length).fill(0);
  let cursor = (best as ParetoPoint).nodeIdx;
  for (let ci = frontiers.length - 1; ci >= 0; ci--) {
    const gNode = globalNodes[cursor];
    const f = frontiers[ci];
    let channelCursor = gNode.quantity; // 渠道内节点下标
    for (let li = f.groups.length - 1; li >= 0; li--) {
      const node = f.nodes[channelCursor];
      quantities[f.groupIndices[li]] = node.quantity;
      channelCursor = node.parent;
    }
    cursor = gNode.parent;
  }
  const solution = buildSolution(input, quantities, statesExplored);
  solution.frontierHash = frontierHash;
  return solution;
}

/** 渠道内 DP：状态 = 花费 * (cap+1) + 截断曝光，保留最大收益；返回帕累托前沿。 */
function solveChannel(groups: AdGroup[], groupIndices: number[], budget: number, cap: number): ChannelFrontier {
  const nodes: LayerNode[] = [{ parent: -1, quantity: 0, revenue: 0 }];
  let frontier = new Map<number, number>(); // key -> nodes 下标
  frontier.set(0, 0);
  for (const group of groups) {
    const next = new Map<number, number>();
    for (const [key, nodeIdx] of frontier) {
      const spend = Math.floor(key / (cap + 1));
      const exposure = key % (cap + 1);
      const node = nodes[nodeIdx];
      for (let q = 0; q <= 10; q++) {
        const newSpend = spend + q * group.unitCost;
        if (newSpend > budget) continue;
        const newExposure = Math.min(cap, exposure + q * group.unitExposure);
        const newRevenue = node.revenue + group.revenue[q];
        const newKey = newSpend * (cap + 1) + newExposure;
        const existingIdx = next.get(newKey);
        if (existingIdx === undefined || newRevenue > nodes[existingIdx].revenue) {
          next.set(newKey, nodes.length);
          nodes.push({ parent: nodeIdx, quantity: q, revenue: newRevenue });
        }
      }
    }
    if (next.size > STATE_LIMIT) throw new Error(`状态空间超过上限 ${STATE_LIMIT}`);
    frontier = next;
  }
  const points: ParetoPoint[] = [...frontier.entries()].map(([key, nodeIdx]) => ({
    cost: Math.floor(key / (cap + 1)),
    exposure: key % (cap + 1),
    revenue: nodes[nodeIdx].revenue,
    nodeIdx,
  }));
  return { points: paretoPrune(points, cap), nodes, groups, groupIndices };
}

/** 帕累托裁剪：剔除被 (成本≤, 曝光≥, 收益≥) 支配的点。
 *  按成本升序扫描，用 bestRev[e] 记录已保留点在曝光 e 的最大收益，
 *  若存在已保留点曝光 ≥ 当前且收益 ≥ 当前，则当前点被支配。O(n·cap)。 */
function paretoPrune(points: ParetoPoint[], cap: number): ParetoPoint[] {
  const sorted = [...points].sort((a, b) => a.cost - b.cost || b.exposure - a.exposure || b.revenue - a.revenue);
  const bestRev = new Array<number>(cap + 1).fill(-1);
  const kept: ParetoPoint[] = [];
  for (const p of sorted) {
    let dominated = false;
    for (let e = p.exposure; e <= cap; e++) {
      if (bestRev[e] >= p.revenue) {
        dominated = true;
        break;
      }
    }
    if (dominated) continue;
    kept.push(p);
    if (p.revenue > bestRev[p.exposure]) bestRev[p.exposure] = p.revenue;
  }
  return kept;
}

export function buildSolution(input: PlanInput, quantities: number[], statesExplored: number): Solution {
  const channelSpend: Record<string, number> = Object.fromEntries(input.channels.map((c) => [c.id, 0]));
  const allocations: Allocation[] = [];
  let totalRevenue = 0;
  let totalCost = 0;
  let totalExposure = 0;
  input.groups.forEach((group, gi) => {
    const q = quantities[gi];
    const cost = q * group.unitCost;
    const exposure = q * group.unitExposure;
    const revenue = group.revenue[q];
    channelSpend[group.channel] += cost;
    totalRevenue += revenue;
    totalCost += cost;
    totalExposure += exposure;
    allocations.push({ groupId: group.id, channel: group.channel, quantity: q, cost, exposure, revenue });
  });
  return {
    status: 'optimal',
    quantities,
    allocations,
    totalRevenue,
    totalCost,
    totalExposure,
    channelSpend,
    statesExplored,
    frontierHash: '',
  };
}
