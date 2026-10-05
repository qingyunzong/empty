import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { split, splitDetailed, squaredDeviation, InfeasibleError, } from "../src/split.js";
describe("core split", () => {
    test("equal weights, remainder ties broken by ID order", () => {
        const alloc = split(100, [
            { id: "c", weight: 1 },
            { id: "a", weight: 1 },
            { id: "b", weight: 1 },
        ]);
        assert.deepEqual([...alloc.entries()].sort(), [
            ["a", 34],
            ["b", 33],
            ["c", 33],
        ]);
    });
    test("proportional integer weights", () => {
        const alloc = split(100, [
            { id: "a", weight: 2 },
            { id: "b", weight: 1 },
            { id: "c", weight: 1 },
        ]);
        assert.equal(alloc.get("a"), 50);
        assert.equal(alloc.get("b"), 25);
        assert.equal(alloc.get("c"), 25);
    });
    test("exact rational weights 1/3 : 1/2 : 1/6", () => {
        const alloc = split(100, [
            { id: "a", weight: { num: 1, den: 3 } },
            { id: "b", weight: { num: 1, den: 2 } },
            { id: "c", weight: { num: 1, den: 6 } },
        ]);
        // ideals: 33.33.., 50, 16.66.. -> largest remainder to c
        assert.equal(alloc.get("a"), 33);
        assert.equal(alloc.get("b"), 50);
        assert.equal(alloc.get("c"), 17);
    });
    test("decimal number weights are parsed exactly", () => {
        const alloc = split(100, [
            { id: "a", weight: 0.2 },
            { id: "b", weight: 0.3 },
            { id: "c", weight: 0.5 },
        ]);
        assert.equal(alloc.get("a"), 20);
        assert.equal(alloc.get("b"), 30);
        assert.equal(alloc.get("c"), 50);
    });
    test("weight 0 with non-zero min is legal and gets exactly its min", () => {
        const alloc = split(10, [
            { id: "a", weight: 0, min: 3 },
            { id: "b", weight: 1 },
        ]);
        assert.equal(alloc.get("a"), 3);
        assert.equal(alloc.get("b"), 7);
    });
    test("saturated recipient exits, remainder redistributed", () => {
        const alloc = split(90, [
            { id: "a", weight: 10, max: 20 },
            { id: "b", weight: 1 },
            { id: "c", weight: 1 },
        ]);
        assert.equal(alloc.get("a"), 20);
        assert.equal(alloc.get("b"), 35);
        assert.equal(alloc.get("c"), 35);
    });
    test("min bounds are filled before proportional distribution", () => {
        const alloc = split(100, [
            { id: "a", weight: 1, min: 40 },
            { id: "b", weight: 1 },
            { id: "c", weight: 1 },
        ]);
        // ideals 33.33 each; a starts at 40 and is already above ideal
        assert.equal(alloc.get("a"), 40);
        assert.equal(alloc.get("b"), 30);
        assert.equal(alloc.get("c"), 30);
    });
    test("all-zero weights fall back to ID order", () => {
        const alloc = split(4, [
            { id: "a", weight: 0 },
            { id: "b", weight: 0 },
            { id: "c", weight: 0 },
        ]);
        assert.equal(alloc.get("a"), 2);
        assert.equal(alloc.get("b"), 1);
        assert.equal(alloc.get("c"), 1);
    });
    test("numeric IDs tie-break numerically", () => {
        const alloc = split(1, [
            { id: 2, weight: 1 },
            { id: 1, weight: 1 },
        ]);
        assert.equal(alloc.get(1), 1);
        assert.equal(alloc.get(2), 0);
    });
    test("infeasible: sum of minimums exceeds total", () => {
        assert.throws(() => split(5, [
            { id: "a", weight: 1, min: 4 },
            { id: "b", weight: 1, min: 4 },
        ]), (err) => err instanceof InfeasibleError);
    });
    test("infeasible: sum of maximums below total", () => {
        assert.throws(() => split(100, [
            { id: "a", weight: 1, max: 10 },
            { id: "b", weight: 1, max: 10 },
        ]), (err) => err instanceof InfeasibleError);
    });
    test("duplicate recipient IDs are rejected", () => {
        assert.throws(() => split(10, [
            { id: "a", weight: 1 },
            { id: "a", weight: 1 },
        ]));
    });
    test("negative weights are rejected", () => {
        assert.throws(() => split(10, [{ id: "a", weight: -1 }]));
        assert.throws(() => split(10, [{ id: "a", weight: { num: -1, den: 2 } }]));
    });
    test("exact squared deviation is computed with BigInt rationals", () => {
        const recipients = [
            { id: "a", weight: { num: 1, den: 3 } },
            { id: "b", weight: { num: 2, den: 3 } },
        ];
        const alloc = split(100, recipients);
        // ideals: 100/3 and 200/3 -> 33/67; scaled cost:
        // (33*3 - 100*1)^2 + (67*3 - 100*2)^2 = 1 + 1 = 2
        assert.equal(squaredDeviation(100, recipients, alloc), 2n);
    });
    test("splitDetailed returns entries sorted by ID and conserving total", () => {
        const entries = splitDetailed(100, [
            { id: "z", weight: 3 },
            { id: "m", weight: 1 },
            { id: "a", weight: 2 },
        ]);
        assert.deepEqual(entries.map((e) => e.id), ["a", "m", "z"]);
        assert.equal(entries.reduce((s, e) => s + e.amount, 0), 100);
    });
});
