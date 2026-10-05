import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllableExecutor, classifyGraph, buildGraph, planFullGraph, } from "../src/index.js";
test("cyclic SCC and its downstream are isolated, everything else runs", async () => {
    // A -> F chain is unrelated to the cycle B <-> C; D and E hang off the cycle.
    const defs = [
        { id: "A" },
        { id: "F", dependsOn: ["A"] },
        { id: "B", dependsOn: ["C"] },
        { id: "C", dependsOn: ["B"] },
        { id: "D", dependsOn: ["B"] },
        { id: "E", dependsOn: ["D"] },
    ];
    const plan = planFullGraph(defs);
    assert.deepEqual(plan.cyclicSccs, [["B", "C"]]);
    assert.deepEqual(plan.isolated, ["B", "C", "D", "E"]);
    assert.deepEqual(plan.startSet, ["A"]);
    const executed = [];
    const executor = new ControllableExecutor(defs, {
        run: (id) => {
            executed.push(id);
        },
    });
    assert.deepEqual(executor.startSet(), ["A"]);
    await executor.runAll();
    assert.deepEqual(executed.sort(), ["A", "F"]);
    assert.deepEqual(executor.results(), [
        { id: "A", status: "passed" },
        { id: "B", status: "isolated" },
        { id: "C", status: "isolated" },
        { id: "D", status: "isolated" },
        { id: "E", status: "isolated" },
        { id: "F", status: "passed" },
    ]);
});
test("self-loop counts as a cycle and is isolated alone", () => {
    const defs = [
        { id: "root" },
        { id: "loopy", dependsOn: ["loopy"] },
        { id: "after", dependsOn: ["root"] },
    ];
    const classification = classifyGraph(buildGraph(defs));
    assert.deepEqual(classification.cyclicSccs, [["loopy"]]);
    assert.deepEqual([...classification.isolated].sort(), ["loopy"]);
    assert.deepEqual(classification.startSet, ["root"]);
});
test("larger SCC (3-cycle) isolates only itself and downstream", async () => {
    const defs = [
        { id: "n1", dependsOn: ["n3"] },
        { id: "n2", dependsOn: ["n1"] },
        { id: "n3", dependsOn: ["n2"] },
        { id: "down", dependsOn: ["n2"] },
        { id: "free" },
    ];
    const plan = planFullGraph(defs);
    assert.deepEqual(plan.cyclicSccs, [["n1", "n2", "n3"]]);
    assert.deepEqual(plan.isolated, ["down", "n1", "n2", "n3"]);
    assert.deepEqual(plan.startSet, ["free"]);
    const executor = new ControllableExecutor(defs);
    await executor.runAll();
    assert.deepEqual(executor.results(), [
        { id: "down", status: "isolated" },
        { id: "free", status: "passed" },
        { id: "n1", status: "isolated" },
        { id: "n2", status: "isolated" },
        { id: "n3", status: "isolated" },
    ]);
});
test("invalid graphs are rejected", () => {
    assert.throws(() => buildGraph([{ id: "a" }, { id: "a" }]));
    assert.throws(() => buildGraph([{ id: "a", dependsOn: ["ghost"] }]));
});
