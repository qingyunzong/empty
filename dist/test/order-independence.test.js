"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const assert = __importStar(require("node:assert/strict"));
const property_1 = require("../src/property");
const gen_1 = require("../src/gen");
const CONFIG = { seed: 20261006, runs: 200 };
const propA = () => (0, property_1.runProperty)("order/prop-a", (0, gen_1.integer)(0, 500), (n) => n < 250, CONFIG);
const propB = () => (0, property_1.runProperty)("order/prop-b", (0, gen_1.arrayOf)((0, gen_1.integer)(0, 100), { maxLength: 10 }), (xs) => !xs.includes(77), CONFIG);
const propC = () => (0, property_1.runProperty)("order/prop-c", (0, gen_1.integer)(-100, 100), (n) => n === 0 || n < -50, CONFIG);
function summarize(r) {
    return {
        ok: r.ok,
        runs: r.runs,
        counterexample: r.record?.counterexample,
        runSeed: r.record?.runSeed,
        runIndex: r.record?.runIndex,
        shrinkPath: r.record?.shrinkPath,
        traceLength: r.record?.shrinkTrace.length,
    };
}
(0, node_test_1.default)("results are identical regardless of execution order", () => {
    // Order 1: A, B, C
    const a1 = summarize(propA());
    const b1 = summarize(propB());
    const c1 = summarize(propC());
    // Order 2: C, A, B (reverse-ish interleaving)
    const c2 = summarize(propC());
    const a2 = summarize(propA());
    const b2 = summarize(propB());
    assert.deepEqual(a1, a2);
    assert.deepEqual(b1, b2);
    assert.deepEqual(c1, c2);
});
(0, node_test_1.default)("re-running the same property in one process is deterministic", () => {
    const first = summarize(propA());
    const second = summarize(propA());
    assert.deepEqual(first, second);
});
(0, node_test_1.default)("each property has an independent stream: renaming changes the stream", () => {
    const r1 = (0, property_1.runProperty)("independent/one", (0, gen_1.integer)(0, 1000), () => true, CONFIG);
    const r2 = (0, property_1.runProperty)("independent/two", (0, gen_1.integer)(0, 1000), () => true, CONFIG);
    assert.ok(r1.ok && r2.ok);
    // Different names -> different property seeds -> independent streams.
    const s1 = (0, property_1.runProperty)("independent/one", (0, gen_1.integer)(0, 1000), (n) => n < 500, CONFIG);
    const s2 = (0, property_1.runProperty)("independent/two", (0, gen_1.integer)(0, 1000), (n) => n < 500, CONFIG);
    assert.notEqual(s1.record?.runSeed, s2.record?.runSeed);
});
