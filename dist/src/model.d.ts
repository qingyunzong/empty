import type { VersionGraph } from "./graph";
/**
 * 暴力参考模型：对每个节点独立 DFS 求全可达祖先集合（含自身），
 * 用于在小 DAG 上核对库实现。与库实现不共享任何代码路径。
 */
export declare function fullReachability(graph: VersionGraph): Map<string, Set<string>>;
/** 模型版 merge bases：先求交集，再剔除"是另一共同祖先真祖先"者。 */
export declare function modelMergeBases(graph: VersionGraph, queries: readonly string[]): string[];
