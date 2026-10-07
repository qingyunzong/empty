import { generatePathCertificate, verifyPathCertificate, } from "./pathCertificate.js";
const EPSILON = 1e-9;
export function verifyOptimalityCertificate(graph, cert, options = {}) {
    const pathResult = verifyPathCertificate(graph, cert.path, options);
    if (!pathResult.ok) {
        return { ok: false, stage: "path", position: pathResult.position, reason: pathResult.reason };
    }
    if (cert.path.source !== cert.source || cert.path.target !== cert.target) {
        return {
            ok: false,
            stage: "path",
            position: 0,
            reason: "path endpoints do not match certificate source/target",
        };
    }
    const potentials = cert.potentials;
    for (const node of graph.nodes()) {
        const value = potentials[node];
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return { ok: false, stage: "potential", node, reason: `missing or non-finite potential for ${node}` };
        }
    }
    for (const edge of graph.edges()) {
        const slack = potentials[edge.to] - potentials[edge.from] - edge.weight;
        if (slack > EPSILON) {
            return {
                ok: false,
                stage: "triangle",
                edgeId: edge.id,
                reason: `triangle inequality violated on ${edge.id}: h[${edge.to}] - h[${edge.from}] = ${potentials[edge.to] - potentials[edge.from]} > ${edge.weight}`,
            };
        }
    }
    const bound = potentials[cert.target] - potentials[cert.source];
    if (Math.abs(cert.path.totalCost - bound) > EPSILON) {
        return {
            ok: false,
            stage: "bound",
            reason: `path cost ${cert.path.totalCost} does not reach the lower bound ${bound}`,
        };
    }
    return { ok: true };
}
/**
 * Builds an optimality certificate via Bellman-Ford. Nodes unreachable from
 * the source get potentials from a zero-initialized relaxation of the
 * unreachable subgraph (no edges lead from reachable to unreachable nodes,
 * so the constraints decouple). Throws if the graph contains a negative
 * cycle, in which case a negative-cycle certificate applies instead.
 */
export function generateOptimalityCertificate(graph, source, target) {
    const nodes = graph.nodes();
    if (!nodes.includes(source))
        throw new Error(`unknown source node: ${source}`);
    if (!nodes.includes(target))
        throw new Error(`unknown target node: ${target}`);
    const edges = graph.edges();
    const dist = new Map(nodes.map((n) => [n, Infinity]));
    dist.set(source, 0);
    const predecessor = new Map();
    relax(edges, dist, nodes.length, predecessor);
    assertNoNegativeCycle(edges, dist);
    const targetDist = dist.get(target);
    if (!Number.isFinite(targetDist)) {
        throw new Error(`no path from ${source} to ${target}`);
    }
    // Potentials for unreachable nodes: zero-initialized relaxation restricted
    // to the unreachable subgraph keeps every triangle inequality satisfiable.
    const potentials = {};
    const unreachable = nodes.filter((n) => !Number.isFinite(dist.get(n)));
    const unreachableSet = new Set(unreachable);
    const subDist = new Map(unreachable.map((n) => [n, 0]));
    const subEdges = edges.filter((e) => unreachableSet.has(e.from) && unreachableSet.has(e.to));
    relax(subEdges, subDist, unreachable.length, null);
    assertNoNegativeCycle(subEdges, subDist);
    for (const node of nodes) {
        const d = dist.get(node);
        potentials[node] = Number.isFinite(d) ? d : subDist.get(node);
    }
    const pathEdgeIds = [];
    let current = target;
    while (current !== source) {
        const edgeId = predecessor.get(current);
        if (edgeId === undefined)
            throw new Error(`no path from ${source} to ${target}`);
        pathEdgeIds.unshift(edgeId);
        current = graph.getEdge(edgeId).from;
    }
    return {
        source,
        target,
        potentials,
        path: generatePathCertificate(graph, source, target, pathEdgeIds),
    };
}
function relax(edges, dist, rounds, predecessor) {
    for (let round = 0; round < rounds; round++) {
        let changed = false;
        for (const edge of edges) {
            const from = dist.get(edge.from);
            const to = dist.get(edge.to);
            if (from !== undefined && to !== undefined && from + edge.weight < to) {
                dist.set(edge.to, from + edge.weight);
                predecessor?.set(edge.to, edge.id);
                changed = true;
            }
        }
        if (!changed)
            break;
    }
}
function assertNoNegativeCycle(edges, dist) {
    for (const edge of edges) {
        const from = dist.get(edge.from);
        const to = dist.get(edge.to);
        if (from !== undefined && to !== undefined && from + edge.weight < to) {
            throw new Error("graph contains a negative cycle; optimality certificates do not exist");
        }
    }
}
