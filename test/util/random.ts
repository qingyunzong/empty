import { VersionGraph } from "../../src/graph";

/** 可复现的伪随机数发生器（mulberry32）。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * 随机小 DAG：按拓扑序提交，每个提交随机挂 0..maxParents 个更早的父提交；
 * 之后再用 addParents 随机补"晚 -> 早"的增量边（必然无环，用于覆盖增量插入路径）。
 */
export function randomDag(
  rand: () => number,
  nodeCount: number,
  maxParents: number,
): VersionGraph {
  const graph = new VersionGraph();
  const ids: string[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const id = `c${i}`;
    const parentBudget = Math.min(maxParents, ids.length);
    const parentCount = randomInt(rand, 0, parentBudget);
    const pool = [...ids];
    const parents: string[] = [];
    for (let k = 0; k < parentCount; k++) {
      const index = randomInt(rand, 0, pool.length - 1);
      parents.push(pool.splice(index, 1)[0]!);
    }
    graph.addCommit(id, parents);
    ids.push(id);
  }
  if (nodeCount >= 2) {
    const extraEdges = randomInt(rand, 0, nodeCount);
    for (let k = 0; k < extraEdges; k++) {
      const childIndex = randomInt(rand, 1, nodeCount - 1);
      const parentIndex = randomInt(rand, 0, childIndex - 1);
      graph.addParents(ids[childIndex]!, [ids[parentIndex]!]);
    }
  }
  return graph;
}

export function randomQueries(
  rand: () => number,
  ids: string[],
  count: number,
): string[] {
  const pool = [...ids];
  const picked: string[] = [];
  for (let k = 0; k < Math.min(count, pool.length); k++) {
    const index = randomInt(rand, 0, pool.length - 1);
    picked.push(pool.splice(index, 1)[0]!);
  }
  return picked;
}
