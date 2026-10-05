import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProblem } from "../src/model.js";
import { shortestPlan, goalDistances, reachableClosure } from "../src/bfs.js";
import { makeHeuristic, certifiedAStar, verifyLowerBounds } from "../src/heuristic.js";
import { randomProblem } from "./helpers.js";
const lights = parseProblem(JSON.parse(readFileSync("examples/lights.json", "utf8")));
const robot = parseProblem(JSON.parse(readFileSync("examples/robot.json", "utf8")));
function stateFromKey(key) {
    const [b, r] = key.split("|");
    return { bits: Number(b), res: r ? r.split(",").map(Number) : [] };
}
test("heuristic is admissible on every reachable state (examples)", () => {
    for (const p of [lights, robot]) {
        const h = makeHeuristic(p);
        const dist = goalDistances(p);
        const closure = reachableClosure(p);
        for (const key of closure.depthOf.keys()) {
            const hv = h(stateFromKey(key));
            const d = dist.get(key);
            if (d !== undefined) {
                assert.ok(hv <= d, `${p.name} ${key}: h=${hv} > dist=${d}`);
            }
        }
    }
});
test("heuristic is admissible on every reachable state (random problems)", () => {
    for (let seed = 1; seed <= 50; seed++) {
        const p = randomProblem(seed);
        const h = makeHeuristic(p);
        const dist = goalDistances(p);
        const closure = reachableClosure(p);
        for (const key of closure.depthOf.keys()) {
            const hv = h(stateFromKey(key));
            const d = dist.get(key);
            if (d !== undefined) {
                assert.ok(hv <= d, `seed ${seed} ${key}: h=${hv} > dist=${d}`);
            }
        }
    }
});
test("A* with certified bounds matches BFS optimum", () => {
    for (const p of [lights, robot]) {
        const bfs = shortestPlan(p);
        const a = certifiedAStar(p);
        assert.equal(a.length, bfs.length, p.name);
        assert.deepEqual(verifyLowerBounds(p, a.bounds), []);
    }
});
test("A* matches BFS optimum on random problems; bounds verify", () => {
    for (let seed = 1; seed <= 50; seed++) {
        const p = randomProblem(seed);
        const bfs = shortestPlan(p);
        const a = certifiedAStar(p);
        assert.equal(a.length, bfs ? bfs.length : null, `seed ${seed}`);
        assert.deepEqual(verifyLowerBounds(p, a.bounds), [], `seed ${seed}`);
    }
});
test("every bound record satisfies f = g + h and h >= 0", () => {
    const a = certifiedAStar(robot);
    assert.ok(a.bounds.length > 0);
    for (const rec of a.bounds) {
        assert.equal(rec.f, rec.g + rec.h);
        assert.ok(rec.h >= 0);
        assert.ok(rec.g >= 0);
    }
});
test("unfixable goal bits yield infinite heuristic (sound prune)", () => {
    const p = parseProblem({
        numBits: 2,
        goal: { bits: { "1": 1 } },
        actions: [{ name: "only0", effects: [{ set: { "0": 1 } }] }],
    });
    const h = makeHeuristic(p);
    assert.equal(h({ bits: 0, res: [] }), Number.POSITIVE_INFINITY);
    const a = certifiedAStar(p);
    assert.equal(a.plan, null);
});
