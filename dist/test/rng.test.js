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
(0, node_test_1.default)("same seed produces the identical stream", () => {
    const a = new rng_1.Rng(42);
    const b = new rng_1.Rng(42);
    for (let i = 0; i < 100; i++) {
        assert.equal(a.nextUint32(), b.nextUint32());
    }
});
(0, node_test_1.default)("different seeds produce different streams", () => {
    const a = new rng_1.Rng(1);
    const b = new rng_1.Rng(2);
    const sa = Array.from({ length: 10 }, () => a.nextUint32());
    const sb = Array.from({ length: 10 }, () => b.nextUint32());
    assert.notDeepEqual(sa, sb);
});
(0, node_test_1.default)("state is a single integer and fully resumable", () => {
    const a = new rng_1.Rng(7);
    a.nextUint32();
    a.nextUint32();
    const snapshot = a.getState();
    assert.equal(typeof snapshot, "number");
    assert.ok(Number.isInteger(snapshot));
    const rest = Array.from({ length: 5 }, () => a.nextUint32());
    const resumed = new rng_1.Rng(snapshot);
    const rest2 = Array.from({ length: 5 }, () => resumed.nextUint32());
    assert.deepEqual(rest, rest2);
});
(0, node_test_1.default)("nextInt stays within inclusive bounds", () => {
    const rng = new rng_1.Rng(123);
    for (let i = 0; i < 1000; i++) {
        const v = rng.nextInt(-3, 3);
        assert.ok(v >= -3 && v <= 3, `out of range: ${v}`);
    }
});
(0, node_test_1.default)("hashSeed is name-sensitive and order-free", () => {
    assert.equal((0, rng_1.hashSeed)(99, "prop-a"), (0, rng_1.hashSeed)(99, "prop-a"));
    assert.notEqual((0, rng_1.hashSeed)(99, "prop-a"), (0, rng_1.hashSeed)(99, "prop-b"));
    assert.notEqual((0, rng_1.hashSeed)(1, "x"), (0, rng_1.hashSeed)(2, "x"));
});
(0, node_test_1.default)("mixSeed is deterministic", () => {
    assert.equal((0, rng_1.mixSeed)(5, 6), (0, rng_1.mixSeed)(5, 6));
    assert.notEqual((0, rng_1.mixSeed)(5, 6), (0, rng_1.mixSeed)(6, 5));
});
