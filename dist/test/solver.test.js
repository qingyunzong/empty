"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const graph_1 = require("../src/graph");
const solver_1 = require("../src/solver");
function spec(partial) {
    return (0, graph_1.normalizeSpec)(partial);
}
(0, node_test_1.test)("compareNodeIds uses natural numeric order", () => {
    strict_1.default.ok((0, solver_1.compareNodeIds)("N2", "N10") < 0);
    strict_1.default.ok((0, solver_1.compareNodeIds)("N10", "N2") > 0);
    strict_1.default.ok((0, solver_1.compareNodeIds)("A", "B") < 0);
    strict_1.default.ok((0, solver_1.compareNodeIds)("2", "10") < 0);
    strict_1.default.equal((0, solver_1.compareNodeIds)("X1", "X1"), 0);
    strict_1.default.ok((0, solver_1.compareNodeIds)("X01", "X1") !== 0); // deterministic tiebreak
});
(0, node_test_1.test)("compareIdSequences: prefix sorts before extension", () => {
    strict_1.default.ok((0, solver_1.compareIdSequences)(["A", "B"], ["A", "B", "C"]) < 0);
    strict_1.default.ok((0, solver_1.compareIdSequences)(["A", "C"], ["A", "B"]) > 0);
    strict_1.default.equal((0, solver_1.compareIdSequences)(["A"], ["A"]), 0);
});
(0, node_test_1.test)("compareCandidates priority: maxEdge, then total, then IDs", () => {
    const c = (nodes, maxEdgeCost, totalCost) => ({
        nodes,
        maxEdgeCost,
        totalCost,
    });
    strict_1.default.ok((0, solver_1.compareCandidates)(c(["A", "B"], 5, 100), c(["A", "C"], 6, 1)) < 0);
    strict_1.default.ok((0, solver_1.compareCandidates)(c(["A", "B"], 5, 9), c(["A", "C"], 5, 10)) < 0);
    strict_1.default.ok((0, solver_1.compareCandidates)(c(["A", "B"], 5, 9), c(["A", "C"], 5, 9)) < 0);
});
(0, node_test_1.test)("bottleneck beats total cost", () => {
    const result = (0, solver_1.solve)(spec({
        start: "S",
        end: "T",
        edges: [
            { from: "S", to: "A", cost: 1 },
            { from: "A", to: "T", cost: 1 },
            { from: "S", to: "B", cost: 5 },
            { from: "B", to: "T", cost: 5 },
            { from: "S", to: "C", cost: 0 },
            { from: "C", to: "T", cost: 0 },
        ],
    }));
    strict_1.default.equal(result.found, true);
    strict_1.default.deepEqual(result.best.nodes, ["S", "C", "T"]);
    strict_1.default.equal(result.best.maxEdgeCost, 0);
    strict_1.default.equal(result.best.totalCost, 0);
});
(0, node_test_1.test)("higher-total path wins when its bottleneck is lower", () => {
    const result = (0, solver_1.solve)(spec({
        start: "S",
        end: "T",
        edges: [
            { from: "S", to: "T", cost: 9 },
            { from: "S", to: "A", cost: 4 },
            { from: "A", to: "T", cost: 6 },
        ],
    }));
    strict_1.default.deepEqual(result.best.nodes, ["S", "A", "T"]);
    strict_1.default.equal(result.best.maxEdgeCost, 6);
    strict_1.default.equal(result.best.totalCost, 10);
});
(0, node_test_1.test)("ID sequence breaks exact cost ties", () => {
    const result = (0, solver_1.solve)(spec({
        start: "S",
        end: "T",
        edges: [
            { from: "S", to: "B", cost: 1 },
            { from: "B", to: "T", cost: 1 },
            { from: "S", to: "A", cost: 1 },
            { from: "A", to: "T", cost: 1 },
        ],
    }));
    strict_1.default.deepEqual(result.best.nodes, ["S", "A", "T"]);
});
(0, node_test_1.test)("checkpoints must all be visited", () => {
    const result = (0, solver_1.solve)(spec({
        start: "S",
        end: "T",
        checkpoints: ["K"],
        edges: [
            { from: "S", to: "T", cost: 1 },
            { from: "S", to: "K", cost: 3 },
            { from: "K", to: "T", cost: 3 },
        ],
    }));
    strict_1.default.equal(result.simplePathCount, 2);
    strict_1.default.equal(result.feasiblePathCount, 1);
    strict_1.default.deepEqual(result.best.nodes, ["S", "K", "T"]);
});
(0, node_test_1.test)("maxNodes caps path length", () => {
    const graph = {
        start: "S",
        end: "T",
        edges: [
            { from: "S", to: "T", cost: 10 },
            { from: "S", to: "A", cost: 1 },
            { from: "A", to: "B", cost: 1 },
            { from: "B", to: "T", cost: 1 },
        ],
    };
    const capped = (0, solver_1.solve)(spec({ ...graph, maxNodes: 3 }));
    strict_1.default.deepEqual(capped.best.nodes, ["S", "T"]);
    const uncapped = (0, solver_1.solve)(spec(graph));
    strict_1.default.deepEqual(uncapped.best.nodes, ["S", "A", "B", "T"]);
    strict_1.default.equal(uncapped.best.maxEdgeCost, 1);
});
(0, node_test_1.test)("default maxNodes is 12", () => {
    const edges = [{ from: "S", to: "T", cost: 100 }];
    let prev = "S";
    for (let i = 1; i <= 11; i++) {
        edges.push({ from: prev, to: `N${i}`, cost: 1 });
        prev = `N${i}`;
    }
    edges.push({ from: prev, to: "T", cost: 1 });
    const result = (0, solver_1.solve)(spec({ start: "S", end: "T", edges }));
    strict_1.default.deepEqual(result.best.nodes, ["S", "T"]);
});
(0, node_test_1.test)("directed edges are one-way; undirected go both ways", () => {
    const directed = (0, solver_1.solve)(spec({ start: "A", end: "B", directed: true, edges: [{ from: "B", to: "A", cost: 1 }] }));
    strict_1.default.equal(directed.found, false);
    const undirected = (0, solver_1.solve)(spec({ start: "A", end: "B", edges: [{ from: "B", to: "A", cost: 1 }] }));
    strict_1.default.equal(undirected.found, true);
});
(0, node_test_1.test)("start equals end yields a single-node path", () => {
    const result = (0, solver_1.solve)(spec({ start: "A", end: "A", edges: [] }));
    strict_1.default.equal(result.found, true);
    strict_1.default.deepEqual(result.best, { nodes: ["A"], maxEdgeCost: 0, totalCost: 0 });
});
(0, node_test_1.test)("no feasible path reported", () => {
    const result = (0, solver_1.solve)(spec({
        start: "S",
        end: "T",
        checkpoints: ["GONE"],
        edges: [{ from: "S", to: "T", cost: 1 }],
    }));
    strict_1.default.equal(result.found, false);
    strict_1.default.equal(result.best, null);
    strict_1.default.equal(result.simplePathCount, 1);
    strict_1.default.equal(result.feasiblePathCount, 0);
});
(0, node_test_1.test)("invalid specs are rejected", () => {
    strict_1.default.throws(() => spec({ start: "S" }));
    strict_1.default.throws(() => spec({ start: "S", end: "T", edges: [{ from: "S", to: "T" }] }));
    strict_1.default.throws(() => spec({ start: "S", end: "T", edges: [], maxNodes: 0 }));
});
function bruteForce(spec) {
    const nodeSet = new Set([spec.start, spec.end]);
    for (const e of spec.edges) {
        nodeSet.add(e.from);
        nodeSet.add(e.to);
    }
    const others = [...nodeSet].filter((n) => n !== spec.start && n !== spec.end);
    const edgeCost = new Map();
    const offer = (from, to, cost) => {
        const key = `${from} ${to}`;
        const prev = edgeCost.get(key);
        if (prev === undefined || cost < prev)
            edgeCost.set(key, cost);
    };
    for (const e of spec.edges) {
        offer(e.from, e.to, e.cost);
        if (!spec.directed)
            offer(e.to, e.from, e.cost);
    }
    const checkpoints = new Set(spec.checkpoints);
    let simplePathCount = 0;
    let feasiblePathCount = 0;
    let best = null;
    const consider = (nodes) => {
        let total = 0;
        let maxEdge = -Infinity;
        for (let i = 0; i + 1 < nodes.length; i++) {
            const cost = edgeCost.get(`${nodes[i]} ${nodes[i + 1]}`);
            if (cost === undefined)
                return;
            total += cost;
            if (cost > maxEdge)
                maxEdge = cost;
        }
        simplePathCount++;
        const present = new Set(nodes);
        for (const cp of checkpoints) {
            if (!present.has(cp))
                return;
        }
        feasiblePathCount++;
        const candidate = {
            nodes,
            maxEdgeCost: maxEdge === -Infinity ? 0 : maxEdge,
            totalCost: total,
        };
        if (best === null || (0, solver_1.compareCandidates)(candidate, best) < 0)
            best = candidate;
    };
    if (spec.start === spec.end) {
        consider([spec.start]);
    }
    else {
        const limit = Math.min(spec.maxNodes, nodeSet.size);
        const chosen = [];
        const used = new Set();
        const pick = () => {
            const k = chosen.length + 2;
            if (k <= limit)
                consider([spec.start, ...chosen, spec.end]);
            if (k >= limit)
                return;
            for (const n of others) {
                if (used.has(n))
                    continue;
                used.add(n);
                chosen.push(n);
                pick();
                chosen.pop();
                used.delete(n);
            }
        };
        pick();
    }
    return { best, simplePathCount, feasiblePathCount };
}
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function randomSpec(rand) {
    const n = 2 + Math.floor(rand() * 5); // 2..6 nodes keeps permutations cheap
    const nodes = Array.from({ length: n }, (_, i) => `N${i}`);
    const directed = rand() < 0.5;
    const edges = [];
    for (const a of nodes) {
        for (const b of nodes) {
            if (a === b)
                continue;
            if (rand() < 0.45) {
                edges.push({ from: a, to: b, cost: 1 + Math.floor(rand() * 20) });
            }
        }
    }
    const checkpointCount = Math.floor(rand() * 3); // 0..2
    const checkpoints = [...nodes].sort(() => rand() - 0.5).slice(0, checkpointCount);
    const maxNodes = 2 + Math.floor(rand() * 11); // 2..12
    return spec({
        start: nodes[0],
        end: nodes[n - 1],
        checkpoints,
        maxNodes,
        directed,
        edges,
    });
}
function assertWitnessValid(spec, candidate) {
    const nodes = candidate.nodes;
    strict_1.default.equal(nodes[0], spec.start);
    strict_1.default.equal(nodes[nodes.length - 1], spec.end);
    strict_1.default.ok(nodes.length <= spec.maxNodes, "node limit respected");
    strict_1.default.equal(new Set(nodes).size, nodes.length, "no repeated nodes");
    for (const cp of spec.checkpoints)
        strict_1.default.ok(nodes.includes(cp), `checkpoint ${cp} visited`);
    const costOf = (from, to) => {
        let best;
        for (const e of spec.edges) {
            const hit = e.from === from && e.to === to;
            const rev = !spec.directed && e.from === to && e.to === from;
            if ((hit || rev) && (best === undefined || e.cost < best))
                best = e.cost;
        }
        return best;
    };
    let total = 0;
    let maxEdge = 0;
    for (let i = 0; i + 1 < nodes.length; i++) {
        const cost = costOf(nodes[i], nodes[i + 1]);
        strict_1.default.ok(cost !== undefined, `edge ${nodes[i]}->${nodes[i + 1]} exists`);
        total += cost;
        maxEdge = Math.max(maxEdge, cost);
    }
    strict_1.default.equal(candidate.totalCost, total);
    strict_1.default.equal(candidate.maxEdgeCost, maxEdge);
}
(0, node_test_1.test)("exhaustive cross-check: solver matches brute force on 400 random small graphs", () => {
    const rand = mulberry32(20261005);
    for (let i = 0; i < 400; i++) {
        const s = randomSpec(rand);
        const expected = bruteForce(s);
        const actual = (0, solver_1.solve)(s);
        strict_1.default.equal(actual.simplePathCount, expected.simplePathCount, `simplePathCount case ${i}`);
        strict_1.default.equal(actual.feasiblePathCount, expected.feasiblePathCount, `feasiblePathCount case ${i}`);
        strict_1.default.deepEqual(actual.best, expected.best, `best witness case ${i}`);
        if (actual.best)
            assertWitnessValid(s, actual.best);
    }
});
