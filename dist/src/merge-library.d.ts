import { type Delta } from "./delta.js";
export type NodeStatus = "applied" | "quarantined" | "isolated";
export type IngestResult = {
    status: "applied";
    id: string;
} | {
    status: "buffered";
    id: string;
    waitingFor: string;
} | {
    status: "quarantined";
    id: string;
} | {
    status: "isolated";
    id: string;
    ancestor: string;
} | {
    status: "duplicate";
    id: string;
};
/**
 * 订阅合并库：
 * - 接收版本差量，每项声明父版本；父缺失时进入缓冲，父到达后自动落图；
 * - 一个父版本可有多个子版本（多分支），不强行线性化；
 * - 查询必须显式指定分支头；
 * - 摘要不匹配的差量被隔离，其后继（含乱序后补到的）一并隔离；
 * - 支持乱序重放，并可与完整版本图构建结果做等价对照。
 */
export declare class MergeLibrary {
    private readonly nodes;
    /** 缺失父版本 id -> 等待它的差量列表。 */
    private readonly pending;
    ingest(delta: Delta): IngestResult;
    private attach;
    /** 从根到指定分支头的差量路径；查询必须指定分支头。 */
    query(branchHeadId: string): Delta[];
    /** 沿分支头路径合并 payload，得到该分支头的版本状态。 */
    mergeState(branchHeadId: string): Record<string, unknown>;
    /** 当前所有已落图分支的叶子（分支头），按 id 排序；被隔离的子代不算分支延伸。 */
    heads(): string[];
    /** 仍在缓冲中等待父版本的差量 id。 */
    buffered(): string[];
    /** 被隔离（含坏摘要本体）的版本 id。 */
    isolated(): string[];
    /**
     * 版本图的规范化快照：仅取决于图结构与节点状态，
     * 与差量到达顺序无关，用于乱序重放与完整构建的等价对照。
     */
    snapshot(): string;
    /** 按给定顺序（可乱序）重放差量流，构建版本图。 */
    static replay(deltas: Iterable<Delta>): MergeLibrary;
    /** 对照两个版本图是否等价（乱序重放 vs 完整构建）。 */
    static equivalent(a: MergeLibrary, b: MergeLibrary): boolean;
}
