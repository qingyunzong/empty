import { VersionGraph } from "../../src/graph";
/** 可复现的伪随机数发生器（mulberry32）。 */
export declare function mulberry32(seed: number): () => number;
export declare function randomInt(rand: () => number, lo: number, hi: number): number;
/**
 * 随机小 DAG：按拓扑序提交，每个提交随机挂 0..maxParents 个更早的父提交；
 * 之后再用 addParents 随机补"晚 -> 早"的增量边（必然无环，用于覆盖增量插入路径）。
 */
export declare function randomDag(rand: () => number, nodeCount: number, maxParents: number): VersionGraph;
export declare function randomQueries(rand: () => number, ids: string[], count: number): string[];
