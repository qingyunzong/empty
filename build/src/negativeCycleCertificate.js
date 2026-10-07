const fail = (position, reason) => ({
    ok: false,
    position,
    reason,
});
export function verifyNegativeCycleCertificate(graph, cert) {
    const { steps, totalWeight } = cert;
    if (steps.length === 0) {
        return fail(0, "a cycle needs at least one edge");
    }
    let start;
    let current;
    let weight = 0;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const edge = graph.getEdge(step.edgeId);
        if (edge === undefined) {
            return fail(i, `unknown edge: ${step.edgeId}`);
        }
        if (edge.version !== step.version) {
            return fail(i, `edge ${edge.id} version mismatch: certificate pins ${step.version}, graph has ${edge.version}`);
        }
        if (current !== undefined && edge.from !== current) {
            return fail(i, `edge ${edge.id} starts at ${edge.from}, expected ${current}`);
        }
        start ??= edge.from;
        current = edge.to;
        weight += edge.weight;
    }
    if (current !== start) {
        return fail(steps.length, `walk ends at ${current}, does not close the cycle at ${start}`);
    }
    if (weight !== totalWeight) {
        return fail(steps.length, `declared weight ${totalWeight} does not match actual weight ${weight}`);
    }
    if (totalWeight >= 0) {
        return fail(steps.length, `cycle weight ${totalWeight} is not negative`);
    }
    return { ok: true };
}
/**
 * Finds a negative cycle with Bellman-Ford (zero-initialized, so cycles
 * unreachable from any particular source are still found) and returns it as
 * a certificate. Returns null when the graph has no negative cycle.
 */
export function generateNegativeCycleCertificate(graph) {
    const nodes = graph.nodes();
    const edges = graph.edges();
    const dist = new Map(nodes.map((n) => [n, 0]));
    const predecessor = new Map();
    let relaxedOnLastRound = null;
    for (let round = 0; round < nodes.length; round++) {
        relaxedOnLastRound = null;
        for (const edge of edges) {
            if (dist.get(edge.from) + edge.weight < dist.get(edge.to)) {
                dist.set(edge.to, dist.get(edge.from) + edge.weight);
                predecessor.set(edge.to, edge.id);
                relaxedOnLastRound = edge.to;
            }
        }
        if (relaxedOnLastRound === null)
            return null;
    }
    // Walk predecessors back |V| times to land inside the cycle, then collect it.
    let node = relaxedOnLastRound;
    for (let i = 0; i < nodes.length; i++) {
        node = graph.getEdge(predecessor.get(node)).from;
    }
    const cycleEdgeIds = [];
    const seen = new Set();
    while (!seen.has(node)) {
        seen.add(node);
        const edgeId = predecessor.get(node);
        cycleEdgeIds.unshift(edgeId);
        node = graph.getEdge(edgeId).from;
    }
    const steps = cycleEdgeIds.map((edgeId) => {
        const edge = graph.getEdge(edgeId);
        return { edgeId: edge.id, version: edge.version };
    });
    const totalWeight = cycleEdgeIds.reduce((sum, id) => sum + graph.getEdge(id).weight, 0);
    return { steps, totalWeight };
}
