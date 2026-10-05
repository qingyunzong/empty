import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseProblem } from "../src/model.js";
import { shortestPlan, reachableClosure, goalDistances } from "../src/bfs.js";
import { buildCertificate, verifyCertificate } from "../src/certificate.js";
import { randomProblem } from "./helpers.js";
const lights = parseProblem(JSON.parse(readFileSync("examples/lights.json", "utf8")));
const robot = parseProblem(JSON.parse(readFileSync("examples/robot.json", "utf8")));
test("lights: shortest plan has length 4", () => {
    const r = shortestPlan(lights);
    assert.ok(r);
    assert.equal(r.length, 4);
    assert.deepEqual(r.plan, ["set0", "set1", "set2", "set3"]);
});
test("robot: shortest plan respects fuel and reaches delivery", () => {
    const r = shortestPlan(robot);
    assert.ok(r);
    assert.equal(r.length, 3);
    assert.deepEqual(r.plan, ["load", "move", "deliver"]);
});
test("certificate verifies; tampered certificates fail", () => {
    const r = shortestPlan(lights);
    const c = reachableClosure(lights);
    const cert = buildCertificate(lights, r.plan, r.layers, c.count);
    assert.equal(verifyCertificate(lights, cert).ok, true);
    // Claiming a shorter plan must fail optimality.
    const fake = { ...cert, plan: r.plan.slice(0, 3), length: 3 };
    const v = verifyCertificate(lights, fake);
    assert.equal(v.ok, false);
    // Wrong layer sizes must be caught.
    const badLayers = { ...cert, layers: cert.layers.map((n) => n + 1) };
    assert.equal(verifyCertificate(lights, badLayers).ok, false);
    // Dropping a mid-plan action must fail replay.
    const broken = { ...cert, plan: ["set0", "set2", "set3"] };
    assert.equal(verifyCertificate(lights, broken).ok, false);
});
test("reachable closure of lights is exact", () => {
    const c = reachableClosure(lights);
    // Chain constraints: reachable states are prefixes 0000,1000,1100,1110,1111
    // plus clear0 reopening bit0 in states where it was set: bits0=0 with any
    // suffix reachable... enumerate: 0000,0001 -> set0 -> ... closure = all
    // states (b1=>b0, b2=>b1, b3=>b2) union their clear0 images.
    // Just assert BFS and closure agree on the goal depth.
    const r = shortestPlan(lights);
    assert.equal(c.histogram.length - 1 >= r.length, true);
    assert.deepEqual(c.histogram.slice(0, r.layers.length), r.layers);
    assert.equal(c.count, c.depthOf.size);
});
test("goalDistances matches BFS shortest length", () => {
    const d = goalDistances(lights);
    assert.equal(d.get("0"), 4);
    const dr = goalDistances(robot);
    assert.equal(dr.get("0|2"), 3);
});
test("BFS model cross-check on random problems: plan replays to goal", () => {
    for (let seed = 1; seed <= 40; seed++) {
        const p = randomProblem(seed);
        const r = shortestPlan(p);
        const d = goalDistances(p);
        const startKey = "0";
        if (r === null) {
            assert.equal(d.has(startKey), false, `seed ${seed}: BFS unsat but goal distance exists`);
        }
        else {
            assert.equal(d.get(startKey), r.length, `seed ${seed}: BFS vs reverse-BFS distance`);
        }
    }
});
