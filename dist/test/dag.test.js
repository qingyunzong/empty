"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const dag_1 = require("../src/dag");
function modelAncestors(model, id) {
    const seen = new Set([id]);
    const stack = [id];
    while (stack.length > 0) {
        const cur = stack.pop();
        for (const [parent, child] of model.edges) {
            if (child === cur && !seen.has(parent)) {
                seen.add(parent);
                stack.push(parent);
            }
        }
    }
    return seen;
}
function modelLcas(model, a, b) {
    const ancA = modelAncestors(model, a);
    const ancB = modelAncestors(model, b);
    const common = [...ancA].filter((x) => ancB.has(x));
    const lowest = common.filter((candidate) => {
        // A common ancestor is lowest iff no other common ancestor sits strictly
        // below it, i.e. is reachable from it in the child direction.
        return !common.some((other) => other !== candidate &&
            modelReachable(model, candidate, other));
    });
    return lowest.sort(dag_1.compareTagIds);
}
function modelReachable(model, from, to) {
    const seen = new Set([from]);
    const stack = [from];
    while (stack.length > 0) {
        const cur = stack.pop();
        for (const [parent, child] of model.edges) {
            if (parent === cur && !seen.has(child)) {
                if (child === to)
                    return true;
                seen.add(child);
                stack.push(child);
            }
        }
    }
    return false;
}
function buildDag(model) {
    const dag = new dag_1.TagDag();
    for (const tag of model.tags)
        dag.addTag(tag);
    dag.applyEdgeBatch(model.edges.map(([parent, child]) => ({ type: "add", parent, child })));
    return dag;
}
function assertDagMatchesModel(dag, model) {
    for (const tag of model.tags) {
        strict_1.default.deepEqual([...dag.ancestorsOf(tag)].sort(dag_1.compareTagIds), [...modelAncestors(model, tag)].sort(dag_1.compareTagIds), `ancestor set mismatch for tag ${String(tag)}`);
    }
    for (const a of model.tags) {
        for (const b of model.tags) {
            strict_1.default.deepEqual(dag.lowestCommonAncestors(a, b), modelLcas(model, a, b), `LCA mismatch for (${String(a)}, ${String(b)})`);
        }
    }
}
// ---------------------------------------------------------------------------
// Deterministic cases
// ---------------------------------------------------------------------------
(0, node_test_1.test)("multiple lowest common ancestors", () => {
    // 1 and 2 are both direct parents of 3 and 4.
    const model = {
        tags: [1, 2, 3, 4],
        edges: [
            [1, 3],
            [1, 4],
            [2, 3],
            [2, 4],
        ],
    };
    const dag = buildDag(model);
    strict_1.default.deepEqual(dag.lowestCommonAncestors(3, 4), [1, 2]);
    assertDagMatchesModel(dag, model);
});
(0, node_test_1.test)("a tag is its own lowest common ancestor", () => {
    const dag = buildDag({
        tags: ["root", "mid", "leaf"],
        edges: [
            ["root", "mid"],
            ["mid", "leaf"],
        ],
    });
    strict_1.default.deepEqual(dag.lowestCommonAncestors("leaf", "leaf"), ["leaf"]);
    strict_1.default.deepEqual(dag.lowestCommonAncestors("root", "leaf"), ["root"]);
    strict_1.default.deepEqual(dag.lowestCommonAncestors("leaf", "mid"), ["mid"]);
});
(0, node_test_1.test)("diamond collapses to the single closest ancestor", () => {
    const dag = buildDag({
        tags: [1, 2, 3, 4],
        edges: [
            [1, 2],
            [1, 3],
            [2, 4],
            [3, 4],
        ],
    });
    strict_1.default.deepEqual(dag.lowestCommonAncestors(2, 3), [1]);
    strict_1.default.deepEqual(dag.lowestCommonAncestors(4, 2), [2]);
});
(0, node_test_1.test)("disconnected tags share no ancestor", () => {
    const dag = buildDag({ tags: ["a", "b"], edges: [] });
    strict_1.default.deepEqual(dag.lowestCommonAncestors("a", "b"), []);
});
(0, node_test_1.test)("results are sorted by id regardless of insertion order", () => {
    const dag = new dag_1.TagDag();
    for (const tag of ["z", "m", "a", "x1", "x2"])
        dag.addTag(tag);
    dag.applyEdgeBatch([
        { type: "add", parent: "z", child: "x1" },
        { type: "add", parent: "m", child: "x1" },
        { type: "add", parent: "a", child: "x1" },
        { type: "add", parent: "z", child: "x2" },
        { type: "add", parent: "m", child: "x2" },
        { type: "add", parent: "a", child: "x2" },
    ]);
    strict_1.default.deepEqual(dag.lowestCommonAncestors("x1", "x2"), ["a", "m", "z"]);
    strict_1.default.deepEqual(dag.tagIds, ["a", "m", "x1", "x2", "z"]);
});
(0, node_test_1.test)("numeric ids sort numerically", () => {
    const dag = buildDag({
        tags: [2, 10, 1, 20, 30],
        edges: [
            [10, 30],
            [2, 30],
            [1, 30],
            [10, 20],
            [2, 20],
            [1, 20],
        ],
    });
    strict_1.default.deepEqual(dag.lowestCommonAncestors(20, 30), [1, 2, 10]);
});
// ---------------------------------------------------------------------------
// Batch edge edits and cycle rejection
// ---------------------------------------------------------------------------
(0, node_test_1.test)("batch adding an edge that closes a cycle is rejected atomically", () => {
    const dag = buildDag({
        tags: [1, 2, 3],
        edges: [
            [1, 2],
            [2, 3],
        ],
    });
    strict_1.default.throws(() => dag.applyEdgeBatch([{ type: "add", parent: 3, child: 1 }]), dag_1.CycleError);
    // Graph untouched.
    strict_1.default.deepEqual(dag.childIds(3), []);
    strict_1.default.deepEqual(dag.parentIds(1), []);
    strict_1.default.deepEqual([...dag.ancestorsOf(3)].sort(dag_1.compareTagIds), [1, 2, 3]);
});
(0, node_test_1.test)("self-loop is rejected", () => {
    const dag = buildDag({ tags: [1], edges: [] });
    strict_1.default.throws(() => dag.applyEdgeBatch([{ type: "add", parent: 1, child: 1 }]), dag_1.CycleError);
    strict_1.default.deepEqual(dag.childIds(1), []);
});
(0, node_test_1.test)("a cycle anywhere in the batch rejects every op in it", () => {
    const dag = buildDag({ tags: [1, 2, 4, 5], edges: [[1, 2]] });
    strict_1.default.throws(() => dag.applyEdgeBatch([
        { type: "add", parent: 4, child: 5 }, // valid on its own
        { type: "add", parent: 5, child: 4 }, // closes a cycle
    ]), dag_1.CycleError);
    strict_1.default.deepEqual(dag.childIds(4), []);
    strict_1.default.deepEqual(dag.childIds(5), []);
});
(0, node_test_1.test)("remove and add in one batch can reverse an edge", () => {
    const dag = buildDag({ tags: [1, 2], edges: [[1, 2]] });
    dag.applyEdgeBatch([
        { type: "remove", parent: 1, child: 2 },
        { type: "add", parent: 2, child: 1 },
    ]);
    strict_1.default.deepEqual(dag.childIds(2), [1]);
    strict_1.default.deepEqual(dag.childIds(1), []);
    strict_1.default.deepEqual(dag.lowestCommonAncestors(1, 2), [2]);
});
(0, node_test_1.test)("single-edge helpers go through the same validation", () => {
    const dag = buildDag({ tags: [1, 2, 3], edges: [[1, 2]] });
    strict_1.default.throws(() => dag.addEdge(2, 1), dag_1.CycleError);
    dag.addEdge(2, 3);
    strict_1.default.deepEqual(dag.parentIds(3), [2]);
    dag.removeEdge(2, 3);
    strict_1.default.deepEqual(dag.parentIds(3), []);
});
(0, node_test_1.test)("unknown tags are rejected", () => {
    const dag = buildDag({ tags: [1], edges: [] });
    strict_1.default.throws(() => dag.addEdge(1, 99), dag_1.UnknownTagError);
    strict_1.default.throws(() => dag.lowestCommonAncestors(1, 99), dag_1.UnknownTagError);
    strict_1.default.throws(() => dag.ancestorsOf(99), dag_1.UnknownTagError);
});
// ---------------------------------------------------------------------------
// Randomized cross-check against the ancestor-set model
// ---------------------------------------------------------------------------
function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
(0, node_test_1.test)("random DAGs match the per-node ancestor-set model", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
        const rand = mulberry32(seed);
        const nodeCount = 2 + Math.floor(rand() * 9);
        const tags = Array.from({ length: nodeCount }, (_, i) => i + 1);
        const edges = [];
        const density = 0.15 + rand() * 0.45;
        // Only link lower -> higher indices so the model graph is acyclic.
        for (let i = 0; i < nodeCount; i += 1) {
            for (let j = i + 1; j < nodeCount; j += 1) {
                if (rand() < density)
                    edges.push([tags[i], tags[j]]);
            }
        }
        const model = { tags, edges };
        const dag = buildDag(model);
        assertDagMatchesModel(dag, model);
        // Explicit self-pair checks (a === b) on every node.
        for (const tag of tags) {
            strict_1.default.deepEqual(dag.lowestCommonAncestors(tag, tag), [tag]);
        }
    }
});
(0, node_test_1.test)("random batch edits keep the graph acyclic and consistent", () => {
    const rand = mulberry32(123456);
    const tags = [1, 2, 3, 4, 5, 6, 7, 8];
    const dag = new dag_1.TagDag();
    for (const tag of tags)
        dag.addTag(tag);
    const model = { tags, edges: [] };
    for (let round = 0; round < 200; round += 1) {
        const parent = tags[Math.floor(rand() * tags.length)];
        const child = tags[Math.floor(rand() * tags.length)];
        const isAdd = rand() < 0.6;
        const op = { type: isAdd ? "add" : "remove", parent, child };
        const wouldCycle = isAdd && (parent === child || modelReachable(model, child, parent));
        if (isAdd && wouldCycle) {
            strict_1.default.throws(() => dag.applyEdgeBatch([op]), dag_1.CycleError);
            continue;
        }
        dag.applyEdgeBatch([op]);
        const idx = model.edges.findIndex(([p, c]) => p === parent && c === child);
        if (isAdd) {
            if (idx === -1)
                model.edges.push([parent, child]);
        }
        else if (idx !== -1) {
            model.edges.splice(idx, 1);
        }
    }
    assertDagMatchesModel(dag, model);
});
