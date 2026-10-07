import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Graph,
  generateNegativeCycleCertificate,
  verifyNegativeCycleCertificate,
  type NegativeCycleCertificate,
} from "../src/index.js";

// Cycle a -> b -> c -> a with total weight 1 - 3 + 1 = -1.
function cyclicGraph(): Graph {
  return new Graph([
    { id: "ab", from: "a", to: "b", weight: 1, version: 1 },
    { id: "bc", from: "b", to: "c", weight: -3, version: 2 },
    { id: "ca", from: "c", to: "a", weight: 1, version: 1 },
    { id: "ad", from: "a", to: "d", weight: 5, version: 1 },
  ]);
}

function validCert(graph: Graph): NegativeCycleCertificate {
  const cert = generateNegativeCycleCertificate(graph);
  assert.notEqual(cert, null);
  return cert!;
}

test("generated negative-cycle certificate verifies", () => {
  const graph = cyclicGraph();
  const cert = validCert(graph);
  assert.equal(cert.totalWeight, -1);
  assert.deepEqual(verifyNegativeCycleCertificate(graph, cert), { ok: true });
});

test("generator returns null when no negative cycle exists", () => {
  const graph = new Graph([
    { id: "ab", from: "a", to: "b", weight: 1, version: 1 },
    { id: "bc", from: "b", to: "c", weight: -3, version: 1 },
    { id: "ca", from: "c", to: "a", weight: 4, version: 1 },
  ]);
  assert.equal(generateNegativeCycleCertificate(graph), null);
});

test("generator finds cycles unreachable from any single source", () => {
  const graph = new Graph([
    { id: "s1", from: "s", to: "t", weight: 1, version: 1 },
    { id: "p", from: "u", to: "v", weight: -2, version: 1 },
    { id: "q", from: "v", to: "u", weight: 0, version: 1 },
  ]);
  const cert = generateNegativeCycleCertificate(graph);
  assert.notEqual(cert, null);
  assert.deepEqual(verifyNegativeCycleCertificate(graph, cert!), { ok: true });
});

const corruptionCases: ReadonlyArray<{
  name: string;
  mutate: (cert: NegativeCycleCertificate) => void;
  position: number;
}> = [
  {
    name: "step version bumped",
    mutate: (c) => void ((c.steps as unknown as { version: number }[])[0]!.version += 1),
    position: 0,
  },
  {
    name: "step edge unknown",
    mutate: (c) => void ((c.steps as unknown as { edgeId: string }[])[1]!.edgeId = "nope"),
    position: 1,
  },
  {
    name: "totalWeight misreported",
    mutate: (c) => void ((c as { totalWeight: number }).totalWeight -= 1),
    position: 3,
  },
  {
    name: "step removed breaks closure",
    mutate: (c) => void (c.steps as unknown[]).splice(1, 1),
    position: 1,
  },
  {
    name: "step replaced breaks contiguity",
    mutate: (c) => void ((c.steps as unknown as { edgeId: string }[])[2]!.edgeId = "ad"),
    position: 2,
  },
];

for (const { name, mutate, position } of corruptionCases) {
  test(`corrupted negative-cycle certificate rejected: ${name}`, () => {
    const graph = cyclicGraph();
    const cert = structuredClone(validCert(graph));
    mutate(cert);
    const result = verifyNegativeCycleCertificate(graph, cert);
    assert.equal(result.ok, false, `expected rejection for: ${name}`);
    assert.equal(result.ok === false && result.position, position);
  });
}

test("non-negative closed walk is rejected", () => {
  const graph = new Graph([
    { id: "ab", from: "a", to: "b", weight: 2, version: 1 },
    { id: "ba", from: "b", to: "a", weight: 1, version: 1 },
  ]);
  const cert: NegativeCycleCertificate = {
    steps: [
      { edgeId: "ab", version: 1 },
      { edgeId: "ba", version: 1 },
    ],
    totalWeight: 3,
  };
  const result = verifyNegativeCycleCertificate(graph, cert);
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /not negative/);
});

test("negative-weight open walk is rejected", () => {
  const graph = cyclicGraph();
  const cert: NegativeCycleCertificate = {
    steps: [
      { edgeId: "ab", version: 1 },
      { edgeId: "bc", version: 2 },
    ],
    totalWeight: -2,
  };
  assert.equal(verifyNegativeCycleCertificate(graph, cert).ok, false);
});

test("edge version bump in the graph invalidates the cycle certificate", () => {
  const graph = cyclicGraph();
  const cert = validCert(graph);
  const bumped = new Graph([
    { id: "ab", from: "a", to: "b", weight: 1, version: 1 },
    { id: "bc", from: "b", to: "c", weight: -3, version: 3 },
    { id: "ca", from: "c", to: "a", weight: 1, version: 1 },
  ]);
  const result = verifyNegativeCycleCertificate(bumped, cert);
  assert.equal(result.ok, false);
  const bcIndex = cert.steps.findIndex((s) => s.edgeId === "bc");
  assert.ok(bcIndex >= 0);
  assert.equal(result.ok === false && result.position, bcIndex);
});
