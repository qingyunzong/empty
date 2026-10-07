import { describe, it } from "node:test";
import { deepEqual, equal, throws } from "node:assert/strict";
import { createTransitionTable, localIntervalToUtc, verifyInverseImage, } from "../src/index.js";
describe("localIntervalToUtc", () => {
    it("requires a non-empty half-open local interval", () => {
        const table = createTransitionTable(0, []);
        throws(() => localIntervalToUtc(table, 100, 100));
        throws(() => localIntervalToUtc(table, 200, 100));
    });
    it("is a plain shift for a fixed offset", () => {
        const table = createTransitionTable(3600, []);
        deepEqual(localIntervalToUtc(table, 3600, 7200), [
            { utcStart: 0, utcEnd: 3600, offsetSeconds: 3600, ruleIndices: [0] },
        ]);
    });
    it("splits across a gap and drops the missing local seconds", () => {
        // offset 0 -> 3600 at utc 1000: local [1000, 4600) does not exist.
        const table = createTransitionTable(0, [{ atUtc: 1000, offsetSeconds: 3600 }]);
        const segments = localIntervalToUtc(table, 500, 5000);
        deepEqual(segments, [
            { utcStart: 500, utcEnd: 1000, offsetSeconds: 0, ruleIndices: [0] },
            { utcStart: 1000, utcEnd: 1400, offsetSeconds: 3600, ruleIndices: [1] },
        ]);
        // 4500 local seconds collapse to 900 UTC seconds (3600 lost to the gap).
        const total = segments.reduce((n, s) => n + (s.utcEnd - s.utcStart), 0);
        equal(total, 900);
    });
    it("returns an empty preimage fully inside a gap", () => {
        const table = createTransitionTable(0, [{ atUtc: 1000, offsetSeconds: 3600 }]);
        deepEqual(localIntervalToUtc(table, 2000, 3000), []);
    });
    it("splits into disjoint segments across an overlap", () => {
        // offset 3600 -> 0 at utc 1000: local [1000, 4600) occurs twice.
        const table = createTransitionTable(3600, [{ atUtc: 1000, offsetSeconds: 0 }]);
        const segments = localIntervalToUtc(table, 2000, 3000);
        deepEqual(segments, [
            { utcStart: -1600, utcEnd: -600, offsetSeconds: 3600, ruleIndices: [0] },
            { utcStart: 2000, utcEnd: 3000, offsetSeconds: 0, ruleIndices: [1] },
        ]);
    });
    it("spans several consecutive transitions, one segment per rule", () => {
        // 0 -> 3600 at 1000 (gap), 3600 -> 0 at 10000 (overlap).
        const table = createTransitionTable(0, [
            { atUtc: 1000, offsetSeconds: 3600 },
            { atUtc: 10000, offsetSeconds: 0 },
        ]);
        const segments = localIntervalToUtc(table, 500, 12000);
        deepEqual(segments, [
            { utcStart: 500, utcEnd: 1000, offsetSeconds: 0, ruleIndices: [0] },
            { utcStart: 1000, utcEnd: 8400, offsetSeconds: 3600, ruleIndices: [1] },
            { utcStart: 10000, utcEnd: 12000, offsetSeconds: 0, ruleIndices: [2] },
        ]);
    });
    it("merges equivalent adjacent segments across redundant transitions", () => {
        // Redundant same-offset transitions split rules but not the mapping.
        const table = createTransitionTable(0, [
            { atUtc: 100, offsetSeconds: 0 },
            { atUtc: 200, offsetSeconds: 0 },
        ]);
        deepEqual(localIntervalToUtc(table, 0, 300), [
            { utcStart: 0, utcEnd: 300, offsetSeconds: 0, ruleIndices: [0, 1, 2] },
        ]);
    });
    it("respects half-open ends exactly", () => {
        const table = createTransitionTable(0, []);
        const [seg] = localIntervalToUtc(table, 0, 100);
        equal(seg.utcStart, 0);
        equal(seg.utcEnd, 100); // utc 100 excluded: its local 100 is the excluded end
    });
});
describe("verifyInverseImage (exhaustive short-domain check)", () => {
    const dst = createTransitionTable(0, [
        { atUtc: 1000, offsetSeconds: 3600 },
        { atUtc: 10000, offsetSeconds: 0 },
    ]);
    it("passes for intervals crossing gap and overlap", () => {
        for (const [start, end] of [
            [500, 5000], // crosses the gap
            [500, 12000], // crosses gap and overlap
            [2000, 3000], // inside the gap -> empty preimage
            [10500, 13000], // inside the overlap -> disjoint segments
            [-5000, 20000], // spans everything
        ]) {
            const report = verifyInverseImage(dst, start, end);
            deepEqual(report.failures, [], `interval [${start}, ${end})`);
        }
    });
    it("passes for exotic rapid consecutive transitions", () => {
        const exotic = createTransitionTable(10, [
            { atUtc: 0, offsetSeconds: 5 },
            { atUtc: 3, offsetSeconds: 0 },
        ]);
        const report = verifyInverseImage(exotic, -50, 50);
        deepEqual(report.failures, []);
    });
});
