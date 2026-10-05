import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllableExecutor, crossCheckStartSet, planFullGraph, } from "../src/index.js";
/** Deterministic PRNG (mulberry32) so generated graphs are reproducible. */
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
/** Random graph over n nodes; edges may point anywhere (cycles allowed). */
function randomDefs(seed, n, edgeProbability) {
    const rand = mulberry32(seed);
    const ids = Array.from({ length: n }, (_, i) => `t${String(i).padStart(3, "0")}`);
    return ids.map((id, i) => ({
        id,
        dependsOn: ids.filter((_, j) => j !== i && rand() < edgeProbability),
    }));
}
test("executor and model agree on the start set for fixed graphs", () => {
    const graphs = [
        [],
        [{ id: "solo" }],
        [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }],
        // cycle with a tail and an independent branch
        [
            { id: "x", dependsOn: ["y"] },
            { id: "y", dependsOn: ["x"] },
            { id: "tail", dependsOn: ["x"] },
            { id: "free" },
            { id: "free2", dependsOn: ["free"] },
        ],
        // self-loop only
        [{ id: "ok" }, { id: "loop", dependsOn: ["loop"] }],
        // two disjoint cycles
        [
            { id: "a1", dependsOn: ["a2"] },
            { id: "a2", dependsOn: ["a1"] },
            { id: "b1", dependsOn: ["b2"] },
            { id: "b2", dependsOn: ["b1"] },
            { id: "root" },
        ],
    ];
    for (const defs of graphs) {
        const agreement = crossCheckStartSet(defs);
        assert.ok(agreement.consistent);
        assert.deepEqual([...agreement.executorStartSet], [...agreement.modelStartSet]);
    }
});
test("executor and model agree on 200 generated graphs (cyclic and acyclic)", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
        const defs = randomDefs(seed, 12, 0.15);
        const agreement = crossCheckStartSet(defs);
        assert.ok(agreement.consistent, `seed ${seed} disagrees`);
        // Spot-check a few: model start set must be exactly the executable
        // zero-dependency nodes.
        if (seed <= 20) {
            const plan = planFullGraph(defs);
            const isolated = new Set(plan.isolated);
            const expected = defs
                .filter((d) => !isolated.has(d.id) && (d.dependsOn ?? []).length === 0)
                .map((d) => d.id)
                .sort();
            assert.deepEqual([...plan.startSet], expected);
        }
    }
});
test("executor start set matches model start set before and after stepping", async () => {
    const defs = randomDefs(42, 15, 0.2);
    const executor = new ControllableExecutor(defs);
    const plan = planFullGraph(defs);
    assert.deepEqual(executor.startSet(), [...plan.startSet]);
    await executor.runAll();
    // Every executable case ran exactly once; isolated ones never ran.
    const ran = executor
        .results()
        .filter((r) => r.status === "passed" || r.status === "failed")
        .map((r) => r.id)
        .sort();
    const executable = defs
        .map((d) => d.id)
        .filter((id) => !plan.isolated.includes(id))
        .sort();
    assert.deepEqual(ran, executable);
});
