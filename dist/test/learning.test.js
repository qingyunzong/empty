import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, initialState, isGoal, parseProblem } from "../src/model.js";
import { shortestPlan, goalDistances } from "../src/bfs.js";
import { dfsLearn } from "../src/learning.js";
import { randomProblem } from "./helpers.js";
import { readFileSync } from "node:fs";
function replay(p, plan) {
    const byName = new Map(p.actions.map((a) => [a.name, a]));
    let s = initialState(p);
    for (const name of plan) {
        const a = byName.get(name);
        if (!a)
            return false;
        const ns = applyAction(p, s, a);
        if (!ns)
            return false;
        s = ns;
    }
    return isGoal(p, s);
}
test("learning search agrees with BFS on solvability (random problems)", () => {
    for (let seed = 1; seed <= 60; seed++) {
        const p = randomProblem(seed);
        const bfs = shortestPlan(p);
        const learned = dfsLearn(p);
        assert.equal(learned.plan !== null, bfs !== null, `seed ${seed}: solvability mismatch`);
        if (learned.plan) {
            assert.ok(replay(p, learned.plan), `seed ${seed}: learned plan does not replay`);
        }
    }
});
test("learned nogoods never exclude a state that can reach the goal", () => {
    for (let seed = 1; seed <= 60; seed++) {
        const p = randomProblem(seed);
        const { nogoods } = dfsLearn(p);
        const canReachGoal = goalDistances(p);
        for (const key of nogoods) {
            assert.equal(canReachGoal.has(key), false, `seed ${seed}: nogood ${key} can still reach the goal`);
        }
    }
});
test("prior nogoods are reused without losing completeness", () => {
    for (let seed = 1; seed <= 40; seed++) {
        const p = randomProblem(seed);
        const first = dfsLearn(p);
        const second = dfsLearn(p, first.nogoods);
        assert.equal(second.plan !== null, first.plan !== null, `seed ${seed}`);
        if (second.plan)
            assert.ok(replay(p, second.plan), `seed ${seed}`);
    }
});
test("cycles do not produce bogus nogoods (clear0 reopens bit0)", () => {
    const lights = parseProblem(JSON.parse(readFileSync("examples/lights.json", "utf8")));
    const r = dfsLearn(lights);
    assert.ok(r.plan, "lights is solvable");
    assert.ok(replay(lights, r.plan));
    // Every state on the BFS-shortest path can reach the goal; none may be a nogood.
    const d = goalDistances(lights);
    for (const key of r.nogoods)
        assert.equal(d.has(key), false);
});
test("unsolvable problem: learning proves it and records dead states", () => {
    const p = parseProblem({
        numBits: 2,
        goal: { bits: { "1": 1 } },
        actions: [
            // Irreversible: 00 -> 01, then stuck. Goal bit1 is never settable.
            { name: "inc0", pre: { bits: { "0": 0 } }, effects: [{ set: { "0": 1 } }] },
        ],
    });
    const r = dfsLearn(p);
    assert.equal(r.plan, null);
    // Both reachable states (0b00 and 0b01) are fully explored and dead.
    assert.deepEqual([...r.nogoods].sort(), ["0", "1"]);
});
test("self-loops stay UNKNOWN: never recorded as nogoods", () => {
    const p = parseProblem({
        numBits: 2,
        goal: { bits: { "1": 1 } },
        actions: [
            { name: "flip0", effects: [{ set: { "0": 1 } }] },
            { name: "back0", effects: [{ set: { "0": 0 } }] },
        ],
    });
    const r = dfsLearn(p);
    assert.equal(r.plan, null);
    // Every successor chain hits a cycle, so nothing is provably dead.
    assert.equal(r.nogoods.length, 0);
});
