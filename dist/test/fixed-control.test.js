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
const fixed_1 = require("../src/fixed");
(0, node_test_1.default)("fixed small generators are deterministic and order-free", () => {
    const gen = (0, fixed_1.smallInts)();
    const run = () => (0, property_1.runProperty)("fixed/determinism", gen, () => true, { seed: 1, runs: 11 });
    assert.ok(run().ok);
    // Enumerate twice, interleaved with other work: identical sequences.
    const seq1 = Array.from({ length: 11 }, (_, i) => gen({}, i).value);
    const seq2 = Array.from({ length: 11 }, (_, i) => gen({}, i).value);
    assert.deepEqual(seq1, seq2);
    assert.deepEqual(seq1, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
(0, node_test_1.default)("control: random shrink converges to the fixed generator's minimal counterexample", () => {
    const check = (n) => n < 7;
    // Control group: fixed small generator finds the minimal counterexample
    // by deterministic enumeration.
    const expected = (0, fixed_1.firstCounterexample)((0, fixed_1.smallInts)(), check, 11);
    assert.equal(expected, 7);
    // Experimental group: random generation + verified shrinking.
    const result = (0, property_1.runProperty)("control/int", (0, gen_1.integer)(0, 1000), check, {
        seed: 424242,
        runs: 200,
    });
    assert.equal(result.ok, false);
    assert.equal(result.record.counterexample, expected, "shrunk random counterexample must equal the fixed-generator minimum");
});
(0, node_test_1.default)("control: array property minimal counterexample matches fixed enumeration", () => {
    const check = (xs) => !xs.some((x) => x >= 3);
    // Control group: fixed generator enumerates singleton lists [0],[1],...
    const singletons = (0, fixed_1.fixedCycle)([[0], [1], [2], [3], [4], [5]]);
    const expected = (0, fixed_1.firstCounterexample)(singletons, check, 6);
    assert.deepEqual(expected, [3]);
    // Experimental group: random arrays + verified shrinking.
    const result = (0, property_1.runProperty)("control/array", (0, gen_1.arrayOf)((0, gen_1.integer)(0, 9), { maxLength: 5 }), check, { seed: 99, runs: 500 });
    assert.equal(result.ok, false);
    assert.deepEqual(result.record.counterexample, expected);
});
(0, node_test_1.default)("fixedCycle wraps around deterministically", () => {
    const gen = (0, fixed_1.fixedCycle)(["x", "y", "z"]);
    const values = Array.from({ length: 7 }, (_, i) => gen({}, i).value);
    assert.deepEqual(values, ["x", "y", "z", "x", "y", "z", "x"]);
});
