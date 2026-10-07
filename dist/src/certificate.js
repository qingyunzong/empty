"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueAncestorCertificate = issueAncestorCertificate;
exports.verifyAncestorCertificate = verifyAncestorCertificate;
exports.issueMergeBaseCertificate = issueMergeBaseCertificate;
exports.verifyMergeBaseCertificate = verifyMergeBaseCertificate;
const graph_1 = require("./graph");
const lca_1 = require("./lca");
/** 为祖先关系签发证书；ancestor 不是 descendant 的祖先时返回 null。 */
function issueAncestorCertificate(graph, ancestor, descendant) {
    if (!graph.has(ancestor))
        throw new graph_1.UnknownCommitError(`unknown commit: ${ancestor}`);
    if (!graph.has(descendant))
        throw new graph_1.UnknownCommitError(`unknown commit: ${descendant}`);
    // 自 descendant 沿父边 BFS，记录 nextHop：父 -> 子（朝 descendant 方向）。
    const nextHop = new Map();
    const queue = [descendant];
    const visited = new Set([descendant]);
    while (queue.length > 0) {
        const node = queue.shift();
        if (node === ancestor)
            break;
        for (const parent of graph.getParents(node)) {
            if (!visited.has(parent)) {
                visited.add(parent);
                nextHop.set(parent, node);
                queue.push(parent);
            }
        }
    }
    if (!visited.has(ancestor))
        return null;
    const path = [ancestor];
    while (path[path.length - 1] !== descendant) {
        path.push(nextHop.get(path[path.length - 1]));
    }
    return { kind: "ancestor", ancestor, descendant, path };
}
/** 逐边核对证书路径；任何一步不成立或端点不符即拒绝。 */
function verifyAncestorCertificate(graph, cert) {
    const { ancestor, descendant, path } = cert;
    if (path.length === 0)
        return false;
    if (path[0] !== ancestor || path[path.length - 1] !== descendant)
        return false;
    try {
        for (let i = 1; i < path.length; i++) {
            if (!graph.getParents(path[i]).includes(path[i - 1]))
                return false;
        }
    }
    catch {
        return false;
    }
    return true;
}
function issueMergeBaseCertificate(graph, queries) {
    const bases = (0, lca_1.lowestCommonAncestors)(graph, queries);
    return {
        kind: "merge-bases",
        queries: [...queries],
        bases: bases.map((base) => ({
            base,
            paths: Object.fromEntries(queries.map((query) => [
                query,
                issueAncestorCertificate(graph, base, query).path,
            ])),
        })),
    };
}
function verifyMergeBaseCertificate(graph, cert) {
    for (const { base, paths } of cert.bases) {
        for (const query of cert.queries) {
            const path = paths[query];
            if (!path)
                return false;
            const ok = verifyAncestorCertificate(graph, {
                kind: "ancestor",
                ancestor: base,
                descendant: query,
                path,
            });
            if (!ok)
                return false;
        }
    }
    return true;
}
