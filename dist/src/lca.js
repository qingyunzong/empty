"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.commonAncestors = commonAncestors;
exports.lowestCommonAncestors = lowestCommonAncestors;
/** 多个基点的共同祖先集合（各基点祖先集含自身的交集）。 */
function commonAncestors(graph, queries) {
    if (queries.length === 0)
        return new Set();
    const common = graph.ancestorsOf(queries[0]);
    for (const query of queries.slice(1)) {
        const ancestors = graph.ancestorsOf(query);
        for (const candidate of [...common]) {
            if (!ancestors.has(candidate))
                common.delete(candidate);
        }
    }
    return common;
}
/**
 * 全部最近共同祖先（merge bases）：共同祖先中不存在"更近的共同后代"者。
 * 即 c 是共同祖先，且不存在另一共同祖先 c'（c' ≠ c）为 c 的真后代。
 *
 * 判定只需检查直接子节点：若 c 的某个真后代 c' 仍是共同祖先，
 * 则 c -> c' 路径上的第一条边 c -> ch 满足 ch 是 c' 的祖先，
 * 从而 ch 也是全部基点的祖先，即 ch 属于共同祖先集合。
 */
function lowestCommonAncestors(graph, queries) {
    const common = commonAncestors(graph, queries);
    const result = [];
    for (const candidate of common) {
        let dominated = false;
        for (const child of graph.getChildren(candidate)) {
            if (common.has(child)) {
                dominated = true;
                break;
            }
        }
        if (!dominated)
            result.push(candidate);
    }
    return result.sort();
}
