import { type VersionGraph } from "./graph";
/**
 * 祖先关系证书：一条从 ancestor 到 descendant 的有向路径，
 * 路径上相邻两点 (u, v) 满足 v 的父提交列表包含 u。
 * 验证者只需逐边核对，无需全图遍历。
 */
export interface AncestorCertificate {
    kind: "ancestor";
    ancestor: string;
    descendant: string;
    path: string[];
}
/** 为祖先关系签发证书；ancestor 不是 descendant 的祖先时返回 null。 */
export declare function issueAncestorCertificate(graph: VersionGraph, ancestor: string, descendant: string): AncestorCertificate | null;
/** 逐边核对证书路径；任何一步不成立或端点不符即拒绝。 */
export declare function verifyAncestorCertificate(graph: VersionGraph, cert: AncestorCertificate): boolean;
/**
 * 合并基点证书：对每个基点，给出它到每个查询基点的祖先路径。
 * 证明"每个基点都是全部查询点的共同祖先"；
 * 基点集合的完备性与极大性由模型核对（见 test/model.test.ts）。
 */
export interface MergeBaseCertificate {
    kind: "merge-bases";
    queries: string[];
    bases: {
        base: string;
        paths: Record<string, string[]>;
    }[];
}
export declare function issueMergeBaseCertificate(graph: VersionGraph, queries: readonly string[]): MergeBaseCertificate;
export declare function verifyMergeBaseCertificate(graph: VersionGraph, cert: MergeBaseCertificate): boolean;
