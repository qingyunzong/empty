import type { Assignment, Certificate, Item } from "./types.js";
import { MAX_ITEMS } from "./types.js";

export function validateItems(items: Item[]): void {
  if (!Array.isArray(items)) throw new Error("items 必须是数组");
  if (items.length > MAX_ITEMS) {
    throw new Error(`字幕条数超过上限 ${MAX_ITEMS}：${items.length}`);
  }
  const seen = new Set<number>();
  for (const it of items) {
    for (const key of ["id", "start", "end", "priority"] as const) {
      if (!Number.isFinite(it[key])) throw new Error(`字幕字段 ${key} 非法：${JSON.stringify(it)}`);
    }
    if (!Number.isInteger(it.id)) throw new Error(`id 必须是整数：${it.id}`);
    if (seen.has(it.id)) throw new Error(`id 重复：${it.id}`);
    seen.add(it.id);
    if (!(it.end > it.start)) {
      throw new Error(`半开区间要求 end > start：id=${it.id} [${it.start}, ${it.end})`);
    }
  }
}

/**
 * 层着色：按开始时间贪心分配最小可用层号（区间图染色，颜色数 == 最大深度）。
 * 半开区间：上一段 end <= 下一段 start 即可复用同层。
 */
export function assignLayers(items: Item[]): Assignment[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  const layerFreeAt: number[] = [];
  const result: Assignment[] = [];
  for (const it of sorted) {
    let layer = layerFreeAt.findIndex((freeAt) => freeAt <= it.start);
    if (layer === -1) {
      layer = layerFreeAt.length;
      layerFreeAt.push(-Infinity);
    }
    layerFreeAt[layer] = it.end;
    result.push({ id: it.id, layer });
  }
  return result.sort((a, b) => a.id - b.id);
}

interface Edge {
  to: number;
  rev: number;
  cap: number;
  cost: bigint;
  itemId: number | null;
}

/**
 * 最多 k 层的最大收益选择：时间轴压缩图上的最小费用流。
 * 相邻时刻边容量 k 费用 0；每条字幕一条 start->end 容量 1 的边。
 * 每次沿最短路增广 1 单位（即一条层的排期），最多增广 k 次，
 * 故任一时刻被选中字幕数 <= 流量 <= k，同层天然不重叠。
 *
 * 并列规则（并列 ID 序）：先最大化总收益；收益相同时按 id 升序逐位比较，
 * 优先包含较小 id（特征向量规则）。用 BigInt 把该规则编码进费用：
 * cost = -(priority * SCALE + bonus)，bonus(id) = 2^(n-rank)，总和 < SCALE。
 */
export function solve(items: Item[], k: number): Certificate {
  validateItems(items);
  if (!Number.isInteger(k) || k < 0) throw new Error(`k 必须是非负整数：${k}`);
  const empty: Certificate = { k, profit: 0, count: 0, selected: [], assignment: [] };
  if (items.length === 0 || k === 0) return empty;

  const n = items.length;
  const SCALE = 1n << BigInt(n + 1);
  const byIdAsc = [...items].sort((a, b) => a.id - b.id);
  const bonus = new Map<number, bigint>();
  byIdAsc.forEach((it, rank) => bonus.set(it.id, 1n << BigInt(n - rank)));

  const times = [...new Set(items.flatMap((it) => [it.start, it.end]))].sort((a, b) => a - b);
  const nodeOf = new Map(times.map((t, i) => [t, i]));
  const nodeCount = times.length;

  const graph: Edge[][] = Array.from({ length: nodeCount }, () => []);
  const addEdge = (from: number, to: number, cap: number, cost: bigint, itemId: number | null): void => {
    graph[from].push({ to, rev: graph[to].length, cap, cost, itemId });
    graph[to].push({ to: from, rev: graph[from].length - 1, cap: 0, cost: -cost, itemId: null });
  };
  for (let i = 0; i + 1 < nodeCount; i++) addEdge(i, i + 1, k, 0n, null);
  const itemEdges: Edge[] = [];
  for (const it of items) {
    const cost = -(BigInt(it.priority) * SCALE + bonus.get(it.id)!);
    addEdge(nodeOf.get(it.start)!, nodeOf.get(it.end)!, 1, cost, it.id);
    itemEdges.push(graph[nodeOf.get(it.start)!][graph[nodeOf.get(it.start)!].length - 1]);
  }

  const source = 0;
  const sink = nodeCount - 1;
  for (let iter = 0; iter < k; iter++) {
    // Bellman-Ford 求最短路（费用可负，图很小）。
    const dist: (bigint | null)[] = Array(nodeCount).fill(null);
    const prevNode: number[] = Array(nodeCount).fill(-1);
    const prevEdge: number[] = Array(nodeCount).fill(-1);
    dist[source] = 0n;
    for (let round = 0; round < nodeCount; round++) {
      let changed = false;
      for (let v = 0; v < nodeCount; v++) {
        if (dist[v] === null) continue;
        for (let ei = 0; ei < graph[v].length; ei++) {
          const e = graph[v][ei];
          if (e.cap <= 0) continue;
          const nd = dist[v]! + e.cost;
          if (dist[e.to] === null || nd < dist[e.to]!) {
            dist[e.to] = nd;
            prevNode[e.to] = v;
            prevEdge[e.to] = ei;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (dist[sink] === null || dist[sink]! >= 0n) break;
    let v = sink;
    while (v !== source) {
      const u = prevNode[v];
      const e = graph[u][prevEdge[v]];
      e.cap -= 1;
      graph[v][e.rev].cap += 1;
      v = u;
    }
  }

  const selectedItems = items.filter((_, i) => itemEdges[i].cap === 0);
  const selected = selectedItems.map((it) => it.id).sort((a, b) => a - b);
  const profit = selectedItems.reduce((sum, it) => sum + it.priority, 0);
  return {
    k,
    profit,
    count: selected.length,
    selected,
    assignment: assignLayers(selectedItems),
  };
}
