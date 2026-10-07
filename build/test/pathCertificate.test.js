import { test } from "node:test";
import assert from "node:assert/strict";
import { Graph, generatePathCertificate, verifyPathCertificate, } from "../src/index.js";
function fixtureGraph() {
    return new Graph([
        { id: "e1", from: "A", to: "B", weight: 2, version: 1 },
        { id: "e2", from: "B", to: "C", weight: 3, version: 1 },
        { id: "e3", from: "C", to: "D", weight: 1, version: 2 },
        { id: "e4", from: "B", to: "D", weight: 10, version: 1 },
        { id: "e5", from: "D", to: "E", weight: 1, version: 1 },
        { id: "e6", from: "C", to: "B", weight: 1, version: 1 },
    ]);
}
function validCert(graph) {
    return generatePathCertificate(graph, "A", "D", ["e1", "e2", "e3"]);
}
test("valid generated certificate verifies", () => {
    const graph = fixtureGraph();
    const result = verifyPathCertificate(graph, validCert(graph));
    assert.deepEqual(result, { ok: true });
});
test("empty path certificate is valid only for zero-cost source == target", () => {
    const graph = fixtureGraph();
    assert.deepEqual(verifyPathCertificate(graph, { source: "A", target: "A", steps: [], totalCost: 0 }), { ok: true });
    assert.equal(verifyPathCertificate(graph, { source: "A", target: "B", steps: [], totalCost: 0 }).ok, false);
    assert.equal(verifyPathCertificate(graph, { source: "A", target: "A", steps: [], totalCost: 1 }).ok, false);
});
// Field-by-field corruption of a genuinely valid certificate: every single
// tampered variant must be rejected at the expected first position.
const corruptionCases = [
    {
        name: "source changed",
        mutate: (c) => void (c.source = "X"),
        position: 0,
    },
    {
        name: "target changed",
        mutate: (c) => void (c.target = "E"),
        position: 3,
    },
    {
        name: "totalCost inflated",
        mutate: (c) => void (c.totalCost += 1),
        position: 3,
    },
    {
        name: "totalCost deflated",
        mutate: (c) => void (c.totalCost -= 1),
        position: 3,
    },
    {
        name: "first step edge unknown",
        mutate: (c) => void (c.steps[0].edgeId = "nope"),
        position: 0,
    },
    {
        name: "middle step version bumped",
        mutate: (c) => void (c.steps[1].version += 1),
        position: 1,
    },
    {
        name: "last step version stale",
        mutate: (c) => void (c.steps[2].version = 1),
        position: 2,
    },
    {
        name: "last step edge breaks contiguity",
        mutate: (c) => void (c.steps[2].edgeId = "e5"),
        position: 2,
    },
    {
        name: "middle step removed",
        mutate: (c) => void c.steps.splice(1, 1),
        position: 1,
    },
    {
        name: "first two steps swapped",
        mutate: (c) => {
            const steps = c.steps;
            const tmp = steps[0];
            steps[0] = steps[1];
            steps[1] = tmp;
        },
        position: 0,
    },
    {
        name: "extra step appended past target",
        mutate: (c) => void c.steps.push({ edgeId: "e5", version: 1 }),
        position: 4,
    },
];
for (const { name, mutate, position } of corruptionCases) {
    test(`corrupted certificate rejected: ${name}`, () => {
        const graph = fixtureGraph();
        const cert = structuredClone(validCert(graph));
        mutate(cert);
        const result = verifyPathCertificate(graph, cert);
        assert.equal(result.ok, false, `expected rejection for: ${name}`);
        assert.equal(result.ok === false && result.position, position);
    });
}
test("edge version bump in the graph invalidates the pinned certificate", () => {
    const graph = fixtureGraph();
    const cert = validCert(graph);
    const bumped = new Graph([
        { id: "e1", from: "A", to: "B", weight: 2, version: 1 },
        { id: "e2", from: "B", to: "C", weight: 3, version: 2 },
        { id: "e3", from: "C", to: "D", weight: 1, version: 2 },
    ]);
    const result = verifyPathCertificate(bumped, cert);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.position, 1);
});
test("repeated nodes rejected by default, allowed by configuration", () => {
    const graph = fixtureGraph();
    // A -> B -> C -> B -> D visits B twice.
    const cert = generatePathCertificate(graph, "A", "D", ["e1", "e2", "e6", "e4"]);
    const rejected = verifyPathCertificate(graph, cert);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.ok === false && rejected.position, 2);
    assert.match(rejected.ok === false ? rejected.reason : "", /repeated/);
    const rejectedExplicit = verifyPathCertificate(graph, cert, { allowRepeatedNodes: false });
    assert.equal(rejectedExplicit.ok, false);
    const allowed = verifyPathCertificate(graph, cert, { allowRepeatedNodes: true });
    assert.deepEqual(allowed, { ok: true });
});
