import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph, generateOptimalityCertificate, generatePathCertificate, verifyOptimalityCertificate, } from "../src/index.js";
// Negative edges but no negative cycle; x/y/z are unreachable from s and
// themselves contain a negative edge, exercising unreachable potentials.
function fixtureGraph() {
    return new Graph([
        { id: "sa", from: "s", to: "a", weight: 1, version: 1 },
        { id: "sb", from: "s", to: "b", weight: 4, version: 1 },
        { id: "ab", from: "a", to: "b", weight: -2, version: 3 },
        { id: "bc", from: "b", to: "c", weight: 3, version: 1 },
        { id: "ac", from: "a", to: "c", weight: 5, version: 1 },
        { id: "xy", from: "x", to: "y", weight: -1, version: 2 },
        { id: "yz", from: "y", to: "z", weight: 2, version: 1 },
        { id: "zx", from: "z", to: "x", weight: 0, version: 1 },
    ]);
}
function validCert(graph) {
    return generateOptimalityCertificate(graph, "s", "c");
}
test("generated optimality certificate verifies, including negative edges", () => {
    const graph = fixtureGraph();
    const cert = validCert(graph);
    assert.deepEqual(verifyOptimalityCertificate(graph, cert), { ok: true });
    // Shortest s->c is s->a->b->c with cost 1 - 2 + 3 = 2.
    assert.equal(cert.path.totalCost, 2);
    assert.deepEqual(cert.path.steps.map((s) => s.edgeId), ["sa", "ab", "bc"]);
    assert.equal(cert.potentials["c"] - cert.potentials["s"], 2);
});
test("generator rejects unreachable target and negative-cycle graphs", () => {
    const graph = fixtureGraph();
    assert.throws(() => generateOptimalityCertificate(graph, "c", "s"), /no path/);
    const cyclic = new Graph([
        { id: "p", from: "u", to: "v", weight: -2, version: 1 },
        { id: "q", from: "v", to: "u", weight: 0, version: 1 },
    ]);
    assert.throws(() => generateOptimalityCertificate(cyclic, "u", "v"), /negative cycle/);
});
test("every potential corruption is rejected", () => {
    const graph = fixtureGraph();
    const cert = validCert(graph);
    for (const node of graph.nodes()) {
        const plus = structuredClone(cert);
        plus.potentials[node] += 1;
        const minus = structuredClone(cert);
        minus.potentials[node] -= 1;
        const plusResult = verifyOptimalityCertificate(graph, plus);
        const minusResult = verifyOptimalityCertificate(graph, minus);
        // A shift in at least one direction must break a tight constraint or the bound.
        assert.ok(!plusResult.ok || !minusResult.ok, `potential shift on node ${node} went undetected`);
        // Nodes on the shortest path tree from s are constrained in both directions.
        if (["s", "a", "b", "c"].includes(node)) {
            assert.equal(plusResult.ok, false, `+1 on ${node} accepted`);
            assert.equal(minusResult.ok, false, `-1 on ${node} accepted`);
        }
    }
});
test("missing potential is rejected at the potential stage", () => {
    const graph = fixtureGraph();
    const cert = structuredClone(validCert(graph));
    delete cert.potentials["b"];
    const result = verifyOptimalityCertificate(graph, cert);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.stage, "potential");
    assert.equal(result.ok === false && result.stage === "potential" && result.node, "b");
});
test("path field corruptions inside optimality certificate are rejected", () => {
    const graph = fixtureGraph();
    const bumpedVersion = structuredClone(validCert(graph));
    bumpedVersion.path.steps[1].version += 1;
    const versionResult = verifyOptimalityCertificate(graph, bumpedVersion);
    assert.equal(versionResult.ok, false);
    assert.equal(versionResult.ok === false && versionResult.stage, "path");
    assert.equal(versionResult.ok === false && versionResult.stage === "path" && versionResult.position, 1);
    const wrongCost = structuredClone(validCert(graph));
    wrongCost.path.totalCost -= 1;
    assert.equal(verifyOptimalityCertificate(graph, wrongCost).ok, false);
    const swappedEndpoints = structuredClone(validCert(graph));
    swappedEndpoints.target = "a";
    assert.equal(verifyOptimalityCertificate(graph, swappedEndpoints).ok, false);
    const wrongEdge = structuredClone(validCert(graph));
    wrongEdge.path.steps[2].edgeId = "ac";
    assert.equal(verifyOptimalityCertificate(graph, wrongEdge).ok, false);
});
test("valid potentials with a non-achieving path are rejected at the bound stage", () => {
    const graph = fixtureGraph();
    const cert = validCert(graph);
    // Keep the genuine potentials but claim the direct s->b->c walk (cost 7) is optimal.
    const fake = {
        source: "s",
        target: "c",
        potentials: cert.potentials,
        path: generatePathCertificate(graph, "s", "c", ["sb", "bc"]),
    };
    const result = verifyOptimalityCertificate(graph, fake);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.stage, "bound");
});
// Small-graph reference: enumerate every simple s-t path, compute the true
// optimum, then check the verifier accepts exactly the paths attaining it.
// This catches false acceptance independently of the generator.
test("exhaustive all-paths reference catches false acceptance", () => {
    const graph = new Graph([
        { id: "s1", from: "s", to: "u", weight: 2, version: 1 },
        { id: "s2", from: "s", to: "v", weight: 5, version: 1 },
        { id: "uv", from: "u", to: "v", weight: -1, version: 1 },
        { id: "uw", from: "u", to: "w", weight: 4, version: 1 },
        { id: "vw", from: "v", to: "w", weight: 1, version: 1 },
        { id: "wt", from: "w", to: "t", weight: 1, version: 1 },
        { id: "vt", from: "v", to: "t", weight: 6, version: 1 },
    ]);
    const allSimplePaths = [];
    const walk = (node, visited, acc) => {
        if (node === "t") {
            allSimplePaths.push([...acc]);
            return;
        }
        for (const edge of graph.outgoing(node)) {
            if (!visited.has(edge.to)) {
                visited.add(edge.to);
                acc.push(edge.id);
                walk(edge.to, visited, acc);
                acc.pop();
                visited.delete(edge.to);
            }
        }
    };
    walk("s", new Set(["s"]), []);
    assert.ok(allSimplePaths.length >= 4, "fixture should have several s-t paths");
    const costOf = (edgeIds) => edgeIds.reduce((sum, id) => sum + graph.getEdge(id).weight, 0);
    const referenceOptimum = Math.min(...allSimplePaths.map(costOf));
    const cert = generateOptimalityCertificate(graph, "s", "t");
    assert.equal(cert.path.totalCost, referenceOptimum);
    assert.deepEqual(verifyOptimalityCertificate(graph, cert), { ok: true });
    // Every simple path paired with the genuine potentials: the verifier must
    // accept exactly those whose cost equals the reference optimum.
    for (const edgeIds of allSimplePaths) {
        const candidate = {
            source: "s",
            target: "t",
            potentials: cert.potentials,
            path: generatePathCertificate(graph, "s", "t", edgeIds),
        };
        const result = verifyOptimalityCertificate(graph, candidate);
        assert.equal(result.ok, costOf(edgeIds) === referenceOptimum, `path ${edgeIds.join(",")} (cost ${costOf(edgeIds)}) misclassified`);
    }
    // A forged bound: potentials lowered at the target so the claimed optimum
    // beats the reference optimum must fail the triangle inequalities.
    const forged = structuredClone(cert);
    forged.potentials["t"] -= 1;
    assert.equal(verifyOptimalityCertificate(graph, forged).ok, false);
});
