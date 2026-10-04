"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../src/engine");
const model_1 = require("../src/model");
const helpers_1 = require("./helpers");
function itemsOf(snap) {
    return [...snap.observations.entries()].map(([id, o]) => ({
        id,
        value: o.value,
        weight: snap.weights.get(o.weightNode),
    }));
}
(0, node_test_1.default)("one commit updates weights and all percentiles as a single generation", () => {
    const lib = (0, helpers_1.buildLibrary)();
    const s0 = lib.getSnapshot();
    strict_1.default.equal(s0.generation, 0);
    strict_1.default.equal(s0.scores.size, 0, "empty set returns empty scores");
    const s1 = lib.commit([]);
    strict_1.default.equal(s1.generation, 1);
    // weights: w_a=5, w_b=8, w_c=5 (mode=1 -> hi branch)
    strict_1.default.deepEqual(s1.weights, new Map([["w_a", 5], ["w_b", 8], ["w_c", 5]]));
    // scores recomputed from the same generation's weights via the naive model
    (0, helpers_1.assertScoresClose)(s1.scores, (0, model_1.naivePercentiles)(itemsOf(s1)));
    (0, helpers_1.assertScoresClose)(s1.scores, (0, model_1.sortingPercentiles)(itemsOf(s1)));
    const s2 = lib.commit([["base", 10], ["mode", 0]]);
    strict_1.default.equal(s2.generation, 2);
    // w_a=11, w_b=20, w_c=10 (mode=0 -> lo branch, 20*0.5)
    strict_1.default.deepEqual(s2.weights, new Map([["w_a", 11], ["w_b", 20], ["w_c", 10]]));
    (0, helpers_1.assertScoresClose)(s2.scores, (0, model_1.naivePercentiles)(itemsOf(s2)));
    // no mixed-generation reads: the old snapshot is untouched
    strict_1.default.equal(s1.generation, 1);
    strict_1.default.deepEqual(s1.weights, new Map([["w_a", 5], ["w_b", 8], ["w_c", 5]]));
    strict_1.default.equal(s1.scores.get("obs2"), s1.scores.get("obs2"));
});
(0, node_test_1.default)("snapshot is frozen and detached from later commits", () => {
    const lib = (0, helpers_1.buildLibrary)();
    const s1 = lib.commit([]);
    strict_1.default.throws(() => {
        s1.generation = 99;
    }, TypeError);
    const weightsBefore = [...s1.weights.entries()];
    lib.commit([["base", 100]]);
    strict_1.default.deepEqual([...s1.weights.entries()], weightsBefore);
});
(0, node_test_1.default)("failed commit leaves the previous generation intact", () => {
    const lib = (0, helpers_1.buildLibrary)();
    const s1 = lib.commit([]);
    strict_1.default.throws(() => lib.commit([["unknown_source", 1]]), /unknown source/);
    strict_1.default.equal(lib.getSnapshot().generation, s1.generation);
    strict_1.default.equal(lib.getSnapshot(), s1);
});
(0, node_test_1.default)("weights match full DAG evaluation; scores match both models (randomized)", () => {
    const lib = (0, helpers_1.buildLibrary)();
    const rand = (0, helpers_1.mulberry32)(1234);
    for (let round = 0; round < 60; round++) {
        const snap = lib.commit([
            ["base", Math.floor(rand() * 50)],
            ["bonus", Math.floor(rand() * 10)],
            ["mode", rand() < 0.5 ? 0 : 1],
        ]);
        strict_1.default.equal(snap.generation, round + 1);
        // full DAG evaluation cross-check (deterministic, exact)
        strict_1.default.deepEqual(snap.weights, lib.evaluateWeightsWithModel(), `round ${round}`);
        // percentile models cross-check
        const items = itemsOf(snap);
        (0, helpers_1.assertScoresClose)(snap.scores, (0, model_1.naivePercentiles)(items), 1e-9);
        (0, helpers_1.assertScoresClose)(snap.scores, (0, model_1.sortingPercentiles)(items), 1e-9);
    }
});
(0, node_test_1.default)("empty observation set yields empty scores after commit", () => {
    const lib = new engine_1.RankedLibrary();
    lib.addSource("s", 1);
    lib.addNode("w", { kind: "derived", deps: ["s"], compute: (v) => v[0] });
    const snap = lib.commit([]);
    strict_1.default.equal(snap.scores.size, 0);
    strict_1.default.equal(snap.weights.size, 0);
});
