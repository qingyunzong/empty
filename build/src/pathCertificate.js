const fail = (position, reason) => ({
    ok: false,
    position,
    reason,
});
export function generatePathCertificate(graph, source, target, edgeIds) {
    const steps = [];
    let current = source;
    let totalCost = 0;
    for (const edgeId of edgeIds) {
        const edge = graph.getEdge(edgeId);
        if (edge === undefined)
            throw new Error(`unknown edge: ${edgeId}`);
        if (edge.from !== current) {
            throw new Error(`edge ${edgeId} does not start at ${current}`);
        }
        steps.push({ edgeId: edge.id, version: edge.version });
        totalCost += edge.weight;
        current = edge.to;
    }
    if (current !== target) {
        throw new Error(`path ends at ${current}, not ${target}`);
    }
    return { source, target, steps, totalCost };
}
export function verifyPathCertificate(graph, cert, options = {}) {
    const allowRepeatedNodes = options.allowRepeatedNodes ?? false;
    const { source, target, steps, totalCost } = cert;
    if (steps.length === 0) {
        if (source !== target) {
            return fail(0, `empty path cannot connect ${source} to ${target}`);
        }
        if (totalCost !== 0) {
            return fail(0, `empty path must have zero cost, got ${totalCost}`);
        }
        return { ok: true };
    }
    const visited = new Set([source]);
    let current = source;
    let cost = 0;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const edge = graph.getEdge(step.edgeId);
        if (edge === undefined) {
            return fail(i, `unknown edge: ${step.edgeId}`);
        }
        if (edge.version !== step.version) {
            return fail(i, `edge ${edge.id} version mismatch: certificate pins ${step.version}, graph has ${edge.version}`);
        }
        if (edge.from !== current) {
            return fail(i, `edge ${edge.id} starts at ${edge.from}, expected ${current}`);
        }
        if (!allowRepeatedNodes && visited.has(edge.to)) {
            return fail(i, `node ${edge.to} is repeated on the path`);
        }
        visited.add(edge.to);
        cost += edge.weight;
        current = edge.to;
    }
    if (current !== target) {
        return fail(steps.length, `path ends at ${current}, not ${target}`);
    }
    if (cost !== totalCost) {
        return fail(steps.length, `declared cost ${totalCost} does not match actual cost ${cost}`);
    }
    return { ok: true };
}
