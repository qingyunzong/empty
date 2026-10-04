"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compareNodeIds = compareNodeIds;
exports.compareIdSequences = compareIdSequences;
exports.compareCandidates = compareCandidates;
exports.solve = solve;
function compareNumericChunks(a, b) {
    const na = a.replace(/^0+/, "") || "0";
    const nb = b.replace(/^0+/, "") || "0";
    if (na.length !== nb.length)
        return na.length - nb.length;
    if (na !== nb)
        return na < nb ? -1 : 1;
    return 0;
}
/** Natural order: digit runs compare numerically ("N2" < "N10"), else bytewise. */
function compareNodeIds(a, b) {
    if (a === b)
        return 0;
    const ca = a.match(/\d+|\D+/g) ?? [];
    const cb = b.match(/\d+|\D+/g) ?? [];
    const shared = Math.min(ca.length, cb.length);
    for (let i = 0; i < shared; i++) {
        const x = ca[i];
        const y = cb[i];
        const xNum = /^\d+$/.test(x);
        const yNum = /^\d+$/.test(y);
        if (xNum && yNum) {
            const d = compareNumericChunks(x, y);
            if (d !== 0)
                return d;
        }
        else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    if (ca.length !== cb.length)
        return ca.length - cb.length;
    return a < b ? -1 : 1;
}
/** Element-wise ID order; a strict prefix sorts before its extension. */
function compareIdSequences(a, b) {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i++) {
        const d = compareNodeIds(a[i], b[i]);
        if (d !== 0)
            return d;
    }
    return a.length - b.length;
}
/** Priority: 1) smaller max edge cost, 2) smaller total cost, 3) smaller ID sequence. */
function compareCandidates(a, b) {
    if (a.maxEdgeCost !== b.maxEdgeCost)
        return a.maxEdgeCost - b.maxEdgeCost;
    if (a.totalCost !== b.totalCost)
        return a.totalCost - b.totalCost;
    return compareIdSequences(a.nodes, b.nodes);
}
/**
 * Exhaustively enumerates simple paths start->end with at most maxNodes nodes
 * (no repeated nodes), keeps those visiting every checkpoint, and returns the
 * best one under compareCandidates.
 */
function solve(spec) {
    // A path is a node sequence, so parallel edges between the same ordered
    // pair collapse to the cheapest one.
    const adjacency = new Map();
    const addEdge = (from, to, cost) => {
        let neighbors = adjacency.get(from);
        if (!neighbors) {
            neighbors = new Map();
            adjacency.set(from, neighbors);
        }
        const prev = neighbors.get(to);
        if (prev === undefined || cost < prev)
            neighbors.set(to, cost);
    };
    for (const edge of spec.edges) {
        addEdge(edge.from, edge.to, edge.cost);
        if (!spec.directed)
            addEdge(edge.to, edge.from, edge.cost);
    }
    const checkpoints = new Set(spec.checkpoints);
    let simplePathCount = 0;
    let feasiblePathCount = 0;
    let best = null;
    const visited = new Set([spec.start]);
    const path = [spec.start];
    let runningTotal = 0;
    let runningMax = -Infinity;
    const finish = () => {
        simplePathCount++;
        for (const cp of checkpoints) {
            if (!visited.has(cp))
                return;
        }
        feasiblePathCount++;
        const candidate = {
            nodes: [...path],
            maxEdgeCost: runningMax === -Infinity ? 0 : runningMax,
            totalCost: runningTotal,
        };
        if (best === null || compareCandidates(candidate, best) < 0)
            best = candidate;
    };
    const dfs = (node) => {
        if (node === spec.end) {
            finish();
            return;
        }
        if (path.length >= spec.maxNodes)
            return;
        for (const [to, cost] of adjacency.get(node) ?? []) {
            if (visited.has(to))
                continue;
            visited.add(to);
            path.push(to);
            const prevTotal = runningTotal;
            const prevMax = runningMax;
            runningTotal += cost;
            runningMax = Math.max(runningMax, cost);
            dfs(to);
            runningTotal = prevTotal;
            runningMax = prevMax;
            path.pop();
            visited.delete(to);
        }
    };
    dfs(spec.start);
    return { found: best !== null, best, simplePathCount, feasiblePathCount };
}
