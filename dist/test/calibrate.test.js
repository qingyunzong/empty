"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const node_fs_1 = require("node:fs");
const cli_1 = require("../src/cli");
const calibrate_1 = require("../src/calibrate");
/** Independent brute-force optimum over the same candidate domain. */
function bruteForce(optionsPerGroup, budget) {
    let bestFn = Infinity;
    let bestVec = [];
    const vec = new Array(optionsPerGroup.length).fill(0);
    const rec = (i, fp, fn) => {
        if (i === optionsPerGroup.length) {
            if (fn < bestFn || (fn === bestFn && (0, calibrate_1.lexCompare)(vec, bestVec) < 0)) {
                bestFn = fn;
                bestVec = vec.slice();
            }
            return;
        }
        for (const o of optionsPerGroup[i]) {
            if (fp + o.fp > budget)
                continue;
            vec[i] = o.threshold;
            rec(i + 1, fp + o.fp, fn + o.fn);
        }
    };
    rec(0, 0, 0);
    return { fn: bestFn, vec: bestVec };
}
function optionsOf(result) {
    return result.certificate.groups.map((g) => g.options);
}
(0, node_test_1.test)("hand-computed two-group case", () => {
    const result = (0, calibrate_1.calibrate)({
        budget: 1,
        groups: [
            {
                name: "a",
                samples: [
                    { score: 5, label: 1 },
                    { score: 6, label: 0 },
                ],
            },
            {
                name: "b",
                samples: [
                    { score: 3, label: 1 },
                    { score: 4, label: 0 },
                ],
            },
        ],
    });
    // Each group: accept-all costs fp=1/fn=0, reject-all costs fp=0/fn=1.
    // Budget 1 -> exactly one group can accept all, total FN = 1 either way.
    // Tie on FN -> lexicographically smallest vector: [5, 5] beats [7, 3].
    strict_1.default.deepEqual(result.thresholds, [5, 5]);
    strict_1.default.equal(result.totals.fn, 1);
    strict_1.default.equal(result.totals.fp, 1);
    strict_1.default.deepEqual(result.groups[0].confusion, { tp: 1, fp: 1, tn: 0, fn: 0 });
    strict_1.default.deepEqual(result.groups[1].confusion, { tp: 0, fp: 0, tn: 1, fn: 1 });
});
(0, node_test_1.test)("tied scores always share the same decision", () => {
    const result = (0, calibrate_1.calibrate)({
        budget: 10,
        groups: [
            {
                samples: [
                    { score: 7, label: 1 },
                    { score: 7, label: 0 },
                    { score: 7, label: 1 },
                    { score: 2, label: 0 },
                ],
            },
        ],
    });
    const c = result.groups[0].confusion;
    // Budget 10 -> accept everything; the whole score-7 block moves together.
    strict_1.default.deepEqual(result.thresholds, [2]);
    strict_1.default.deepEqual(c, { tp: 2, fp: 2, tn: 0, fn: 0 });
});
(0, node_test_1.test)("lexicographic tie-break picks smallest threshold vector", () => {
    // In each group the negative outranks the positive, so FN 0 costs FP 1
    // (accept all) and FN 1 costs FP 0 (reject all). Budget 1 forces total
    // FN = 1; the lexicographically smallest optimal vector wins.
    const result = (0, calibrate_1.calibrate)({
        budget: 1,
        groups: [
            {
                samples: [
                    { score: 1, label: 1 },
                    { score: 2, label: 0 },
                ],
            },
            {
                samples: [
                    { score: 9, label: 1 },
                    { score: 10, label: 0 },
                ],
            },
        ],
    });
    strict_1.default.equal(result.totals.fn, 1);
    strict_1.default.deepEqual(result.thresholds, [1, 11]); // [1,11] < [3,9] lexicographically
});
(0, node_test_1.test)("budget constraint is never violated", () => {
    const result = (0, calibrate_1.calibrate)({
        budget: 0,
        groups: [
            {
                samples: [
                    { score: 5, label: 0 },
                    { score: 9, label: 1 },
                ],
            },
        ],
    });
    strict_1.default.equal(result.totals.fp, 0);
    strict_1.default.deepEqual(result.thresholds, [9]); // accept the positive, reject the negative
    strict_1.default.equal(result.totals.fn, 0);
});
(0, node_test_1.test)("sample versions add and remove samples", () => {
    const input = {
        budget: 5,
        groups: [
            {
                samples: [
                    { id: "keep", score: 5, label: 1 },
                    { id: "added-later", score: 1, label: 0, since: 2 },
                    { id: "removed", score: 9, label: 0, until: 2 },
                ],
            },
        ],
    };
    const v0 = (0, calibrate_1.calibrate)({ ...input, version: 0 });
    strict_1.default.equal(v0.groups[0].sampleCount, 2); // keep + removed
    const v2 = (0, calibrate_1.calibrate)({ ...input, version: 2 });
    strict_1.default.equal(v2.groups[0].sampleCount, 2); // keep + added-later
    const v3 = (0, calibrate_1.calibrate)({ ...input, version: 3 });
    strict_1.default.equal(v3.groups[0].sampleCount, 2);
    // Default version = latest mentioned (2).
    strict_1.default.equal((0, calibrate_1.resolveVersion)((0, calibrate_1.normalizeInput)(input)), 2);
});
(0, node_test_1.test)("rejects more than 8 groups and bad scores", () => {
    strict_1.default.throws(() => (0, calibrate_1.calibrate)({ budget: 1, groups: Array.from({ length: 9 }, () => ({ samples: [] })) }));
    strict_1.default.throws(() => (0, calibrate_1.calibrate)({ budget: 1, groups: [{ samples: [{ score: 1.5, label: 1 }] }] }));
    strict_1.default.throws(() => (0, calibrate_1.calibrate)({ budget: -1, groups: [{ samples: [] }] }));
});
(0, node_test_1.test)("empty group gets a trivial threshold", () => {
    const result = (0, calibrate_1.calibrate)({
        budget: 0,
        groups: [{ name: "empty", samples: [] }, { samples: [{ score: 3, label: 1 }] }],
    });
    strict_1.default.deepEqual(result.groups[0].confusion, { tp: 0, fp: 0, tn: 0, fn: 0 });
    strict_1.default.equal(result.totals.fn, 0);
});
(0, node_test_1.test)("confusion matrices sum to group sample counts", () => {
    const result = (0, calibrate_1.calibrate)({
        budget: 2,
        groups: [
            {
                samples: [
                    { score: 1, label: 1 },
                    { score: 2, label: 0 },
                    { score: 3, label: 1 },
                ],
            },
            {
                samples: [
                    { score: 4, label: 0 },
                    { score: 5, label: 0 },
                ],
            },
        ],
    });
    const counts = [3, 2];
    result.groups.forEach((g, i) => {
        const c = g.confusion;
        strict_1.default.equal(c.tp + c.fp + c.tn + c.fn, counts[i]);
    });
});
(0, node_test_1.test)("exhaustive certificate matches DP on a small domain", () => {
    const result = (0, calibrate_1.calibrate)({
        budget: 3,
        groups: [
            {
                samples: [
                    { score: 6, label: 1 },
                    { score: 4, label: 0 },
                    { score: 2, label: 1 },
                ],
            },
            {
                samples: [
                    { score: 5, label: 0 },
                    { score: 1, label: 1 },
                ],
            },
        ],
    });
    strict_1.default.equal(result.certificate.exhaustive.performed, true);
    strict_1.default.equal(result.certificate.exhaustive.matchesDp, true);
    strict_1.default.equal(result.certificate.exhaustive.combinations, 4 * 3);
    strict_1.default.equal(result.certificate.dp.tableIncluded, true);
});
(0, node_test_1.test)("exhaustive check is skipped beyond the verify limit", () => {
    const result = (0, calibrate_1.calibrate)({ budget: 1, groups: [{ samples: [{ score: 1, label: 1 }] }] }, { verifyLimit: 0 });
    strict_1.default.equal(result.certificate.exhaustive.performed, false);
});
(0, node_test_1.test)("randomized cross-check: DP equals independent brute force", () => {
    let seed = 0xC0FFEE;
    const rand = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed;
    };
    for (let trial = 0; trial < 300; trial++) {
        const groupCount = 1 + (rand() % 4);
        const groups = Array.from({ length: groupCount }, () => ({
            samples: Array.from({ length: rand() % 8 }, () => ({
                score: rand() % 7,
                label: rand() % 2,
            })),
        }));
        const budget = rand() % 6;
        const result = (0, calibrate_1.calibrate)({ budget, groups });
        const bf = bruteForce(optionsOf(result), budget);
        strict_1.default.equal(result.totals.fn, bf.fn, `FN mismatch on trial ${trial}`);
        strict_1.default.deepEqual(result.thresholds, bf.vec, `threshold vector mismatch on trial ${trial}`);
        strict_1.default.ok(result.totals.fp <= budget, `budget violated on trial ${trial}`);
        strict_1.default.equal(result.certificate.exhaustive.matchesDp, true, `certificate mismatch on trial ${trial}`);
    }
});
(0, node_test_1.test)("buildOptions domain is distinct scores plus max+1", () => {
    const opts = (0, calibrate_1.buildOptions)([
        { id: "a", score: 3, label: true },
        { id: "b", score: 3, label: false },
        { id: "c", score: 9, label: false },
    ]);
    strict_1.default.deepEqual(opts.map((o) => o.threshold), [3, 9, 10]);
    strict_1.default.deepEqual(opts[0], { threshold: 3, tp: 1, fp: 2, tn: 0, fn: 0 });
    strict_1.default.deepEqual(opts[2], { threshold: 10, tp: 0, fp: 0, tn: 2, fn: 1 });
});
(0, node_test_1.test)("activeSamples honours since/until boundaries", () => {
    const group = {
        samples: [
            { id: "x", score: 1, label: 1, since: 2, until: 5 },
            { id: "y", score: 1, label: 0 },
        ],
    };
    strict_1.default.deepEqual((0, calibrate_1.activeSamples)(group, 1, 0).map((s) => s.id), ["y"]);
    strict_1.default.deepEqual((0, calibrate_1.activeSamples)(group, 2, 0).map((s) => s.id), ["x", "y"]);
    strict_1.default.deepEqual((0, calibrate_1.activeSamples)(group, 4, 0).map((s) => s.id), ["x", "y"]);
    strict_1.default.deepEqual((0, calibrate_1.activeSamples)(group, 5, 0).map((s) => s.id), ["y"]);
});
(0, node_test_1.test)("CLI end-to-end via runCli with file input and override flags", () => {
    const input = JSON.stringify({
        budget: 1,
        groups: [
            {
                name: "g",
                samples: [
                    { score: 5, label: 1 },
                    { score: 4, label: 0 },
                ],
            },
        ],
    });
    const tmpPath = `/tmp/calibrate-cli-test-${Date.now()}.json`;
    (0, node_fs_1.writeFileSync)(tmpPath, input);
    const out = (0, cli_1.runCli)([tmpPath, "--compact"]);
    const parsed = JSON.parse(out);
    // fn=0 is reachable at t=4 (fp=1) and t=5 (fp=0); lex-min picks t=4.
    strict_1.default.deepEqual(parsed.thresholds, [4]);
    strict_1.default.deepEqual(parsed.groups[0].confusion, { tp: 1, fp: 1, tn: 0, fn: 0 });
    strict_1.default.equal(parsed.certificate.exhaustive.matchesDp, true);
    const out2 = (0, cli_1.runCli)([tmpPath, "--budget", "0", "--compact"]);
    const parsed2 = JSON.parse(out2);
    strict_1.default.deepEqual(parsed2.thresholds, [5]); // fp=0: accept positive at 5, reject negative at 4
    strict_1.default.equal(parsed2.totals.fp, 0);
    // Stdin path and validation errors.
    const out3 = (0, cli_1.runCli)(["--compact"], () => input);
    strict_1.default.deepEqual(JSON.parse(out3).thresholds, [4]);
    strict_1.default.throws(() => (0, cli_1.runCli)([tmpPath, "--budget", "-3"]));
    strict_1.default.ok((0, cli_1.runCli)(["--help"]).includes("Usage: calibrate"));
    (0, node_fs_1.unlinkSync)(tmpPath);
});
