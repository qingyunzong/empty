"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.mulberry32 = mulberry32;
exports.assertClose = assertClose;
exports.assertScoresClose = assertScoresClose;
exports.buildLibrary = buildLibrary;
const strict_1 = __importDefault(require("node:assert/strict"));
const engine_1 = require("../src/engine");
/** Deterministic PRNG so randomized tests are reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function assertClose(actual, expected, tol = 1e-9, message = "") {
    const scale = Math.max(1, Math.abs(expected));
    if (!(Math.abs(actual - expected) <= tol * scale)) {
        strict_1.default.fail(`expected ${actual} ~= ${expected} (tol ${tol}) ${message}`);
    }
}
function assertScoresClose(actual, expected, tol = 1e-9) {
    strict_1.default.equal(actual.size, expected.size, "score map sizes differ");
    for (const [id, p] of expected) {
        const a = actual.get(id);
        strict_1.default.ok(a !== undefined, `missing score for id ${id}`);
        assertClose(a, p, tol, `score mismatch for id ${id}`);
    }
}
/** Standard topology shared by the engine and persistence tests. */
function buildLibrary() {
    const lib = new engine_1.RankedLibrary();
    lib.addSource("base", 4);
    lib.addSource("bonus", 1);
    lib.addSource("mode", 1);
    lib.addNode("w_a", { kind: "derived", deps: ["base", "bonus"], compute: (v) => v[0] + v[1] });
    lib.addNode("w_b", { kind: "derived", deps: ["base"], compute: (v) => v[0] * 2 });
    lib.addNode("w_c", {
        kind: "conditional",
        conditionDeps: ["mode"],
        select: (v) => (v[0] >= 0.5 ? "hi" : "lo"),
        branches: {
            hi: { deps: ["w_a"], compute: (v) => v[0] },
            lo: { deps: ["w_b"], compute: (v) => v[0] * 0.5 },
        },
    });
    lib.addObservation("obs1", 10, "w_a");
    lib.addObservation("obs2", 20, "w_b");
    lib.addObservation("obs3", 30, "w_c");
    return lib;
}
