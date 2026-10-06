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
const rng_1 = require("../src/rng");
const gen_1 = require("../src/gen");
const shrink_1 = require("../src/shrink");
function shrinkFirstFailing(gen, fails, seed) {
    const rng = new rng_1.Rng(seed);
    for (let size = 0; size < 1000; size++) {
        const tree = gen(rng, size);
        if (fails(tree.value))
            return (0, shrink_1.shrink)(tree, fails);
    }
    throw new Error("no failing case found");
}
(0, node_test_1.default)("shrinks to the true minimum that still fails", () => {
    const fails = (n) => n >= 5;
    const result = shrinkFirstFailing((0, gen_1.integer)(0, 100), fails, 1);
    assert.equal(result.minimal, 5);
});
(0, node_test_1.default)("every accepted trace step genuinely fails; rejected ones do not", () => {
    const fails = (n) => n >= 5;
    const result = shrinkFirstFailing((0, gen_1.integer)(0, 100), fails, 2);
    assert.ok(result.trace.length > 0);
    for (const step of result.trace) {
        const candidate = step.candidate;
        assert.equal(step.accepted, fails(candidate), `trace step ${candidate} acceptance mismatch`);
    }
    // The minimal value fails, and anything smaller accepted nowhere.
    assert.ok(fails(result.minimal));
    assert.ok(result.acceptedPath.length > 0);
});
(0, node_test_1.default)("non-monotonic property: passing candidates are never accepted", () => {
    // Fails only for even numbers >= 10. A naive shrinker that accepts
    // candidates without re-checking could land on an odd number.
    const fails = (n) => n >= 10 && n % 2 === 0;
    const result = shrinkFirstFailing((0, gen_1.integer)(0, 60), fails, 3);
    assert.ok(fails(result.minimal), `minimal ${result.minimal} must genuinely fail`);
    assert.equal(result.minimal, 10);
    for (const step of result.trace) {
        if (step.accepted)
            assert.ok(fails(step.candidate));
    }
});
(0, node_test_1.default)("arrays shrink towards shorter, smaller-element counterexamples", () => {
    // Fails when the array contains a value >= 3.
    const fails = (xs) => xs.some((x) => x >= 3);
    const result = shrinkFirstFailing((0, gen_1.arrayOf)((0, gen_1.integer)(0, 20), { maxLength: 8 }), fails, 4);
    assert.ok(fails(result.minimal));
    assert.deepEqual(result.minimal, [3]);
});
(0, node_test_1.default)("shrinking terminates and re-runs the property a bounded number of times", () => {
    const fails = (n) => n > 0;
    let calls = 0;
    const counting = (n) => {
        calls++;
        return fails(n);
    };
    const rng = new rng_1.Rng(9);
    const tree = (0, gen_1.integer)(0, 1000)(rng, 0);
    const result = (0, shrink_1.shrink)(tree, counting);
    assert.equal(result.minimal, 1);
    assert.equal(result.attempts, result.trace.length);
    assert.ok(calls <= 100, `too many shrink attempts: ${calls}`);
});
