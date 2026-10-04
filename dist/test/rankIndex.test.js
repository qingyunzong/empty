"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const rankIndex_1 = require("../src/rankIndex");
const model_1 = require("../src/model");
const helpers_1 = require("./helpers");
(0, node_test_1.default)("percentile = (strictly-less weight + half equal weight) / total weight", () => {
    const index = new rankIndex_1.WeightedRankIndex();
    index.set("a", 10, 1);
    index.set("b", 20, 2);
    index.set("c", 30, 3);
    // total = 6
    (0, helpers_1.assertClose)(index.percentileOf(10), (0 + 0.5) / 6);
    (0, helpers_1.assertClose)(index.percentileOf(20), (1 + 1) / 6);
    (0, helpers_1.assertClose)(index.percentileOf(30), (3 + 1.5) / 6);
    // query value not present: equal weight is zero
    (0, helpers_1.assertClose)(index.percentileOf(15), 1 / 6);
    (0, helpers_1.assertClose)(index.percentileOf(0), 0);
    (0, helpers_1.assertClose)(index.percentileOf(100), 1);
});
(0, node_test_1.default)("equal values share half of their combined weight", () => {
    const index = new rankIndex_1.WeightedRankIndex();
    index.set("a", 5, 1);
    index.set("b", 5, 3);
    index.set("c", 7, 2);
    // total = 6; value 5: (0 + 0.5*4)/6; value 7: (4 + 1)/6
    const scores = index.scores();
    (0, helpers_1.assertClose)(scores.get("a"), 2 / 6);
    (0, helpers_1.assertClose)(scores.get("b"), 2 / 6);
    (0, helpers_1.assertClose)(scores.get("c"), 5 / 6);
});
(0, node_test_1.default)("empty set returns empty results", () => {
    const index = new rankIndex_1.WeightedRankIndex();
    strict_1.default.equal(index.percentileOf(1), null);
    strict_1.default.equal(index.scores().size, 0);
    // zero total weight behaves like empty
    index.set("z", 1, 0);
    strict_1.default.equal(index.percentileOf(1), null);
    strict_1.default.equal(index.scores().size, 0);
});
(0, node_test_1.default)("updates and deletes are exact", () => {
    const index = new rankIndex_1.WeightedRankIndex();
    index.set("a", 1, 1);
    index.set("b", 2, 1);
    (0, helpers_1.assertClose)(index.total, 2);
    // update replaces the old contribution exactly
    index.set("a", 3, 2);
    (0, helpers_1.assertClose)(index.total, 3);
    (0, helpers_1.assertClose)(index.percentileOf(2), (0 + 0.5) / 3);
    (0, helpers_1.assertClose)(index.percentileOf(3), (1 + 1) / 3);
    // delete removes exactly what was added
    strict_1.default.equal(index.delete("a"), true);
    (0, helpers_1.assertClose)(index.total, 1);
    (0, helpers_1.assertClose)(index.percentileOf(2), 0.5);
    strict_1.default.equal(index.delete("missing"), false);
    strict_1.default.equal(index.delete("b"), true);
    strict_1.default.equal(index.size, 0);
    (0, helpers_1.assertClose)(index.total, 0);
    strict_1.default.equal(index.scores().size, 0);
});
(0, node_test_1.default)("rejects invalid input", () => {
    const index = new rankIndex_1.WeightedRankIndex();
    strict_1.default.throws(() => index.set("x", NaN, 1), RangeError);
    strict_1.default.throws(() => index.set("x", 1, -1), RangeError);
    strict_1.default.throws(() => index.set("x", 1, Infinity), RangeError);
});
(0, node_test_1.default)("randomized ops cross-checked against per-item accumulation and sorting models", () => {
    const rand = (0, helpers_1.mulberry32)(42);
    const index = new rankIndex_1.WeightedRankIndex();
    const shadow = new Map();
    const checkAll = (step) => {
        const items = [...shadow.values()];
        (0, helpers_1.assertScoresClose)(index.scores(), (0, model_1.naivePercentiles)(items), 1e-9);
        (0, helpers_1.assertScoresClose)(index.scores(), (0, model_1.sortingPercentiles)(items), 1e-9);
        const total = items.reduce((s, it) => s + it.weight, 0);
        (0, helpers_1.assertClose)(index.total, total, 1e-9, `total weight at step ${step}`);
        strict_1.default.equal(index.size, shadow.size);
    };
    for (let step = 0; step < 800; step++) {
        const id = `id${Math.floor(rand() * 60)}`;
        if (rand() < 0.7) {
            const value = Math.floor(rand() * 16); // small range forces ties
            const weight = Math.floor(rand() * 100) / 10;
            index.set(id, value, weight);
            shadow.set(id, { id, value, weight });
        }
        else {
            index.delete(id);
            shadow.delete(id);
        }
        if (step % 20 === 0)
            checkAll(step);
    }
    checkAll(800);
});
