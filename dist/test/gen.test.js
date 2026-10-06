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
(0, node_test_1.default)("integer generates within bounds", () => {
    const rng = new rng_1.Rng(2024);
    const gen = (0, gen_1.integer)(10, 20);
    for (let i = 0; i < 200; i++) {
        const v = gen(rng, i).value;
        assert.ok(v >= 10 && v <= 20);
    }
});
(0, node_test_1.default)("constant ignores the rng entirely", () => {
    const gen = (0, gen_1.constant)("hello");
    const a = gen(new rng_1.Rng(1), 0).value;
    const b = gen(new rng_1.Rng(999999), 50).value;
    assert.equal(a, "hello");
    assert.equal(b, "hello");
});
(0, node_test_1.default)("arrayOf respects length bounds", () => {
    const rng = new rng_1.Rng(5);
    const gen = (0, gen_1.arrayOf)((0, gen_1.integer)(0, 9), { minLength: 2, maxLength: 6 });
    for (let i = 0; i < 200; i++) {
        const v = gen(rng, i).value;
        assert.ok(v.length >= 2 && v.length <= 6, `length ${v.length}`);
    }
});
(0, node_test_1.default)("map transforms values", () => {
    const gen = (0, gen_1.map)((0, gen_1.integer)(1, 1), (n) => n * 10);
    assert.equal(gen(new rng_1.Rng(0), 0).value, 10);
});
(0, node_test_1.default)("oneOf only produces values from its generators", () => {
    const rng = new rng_1.Rng(77);
    const gen = (0, gen_1.oneOf)((0, gen_1.constant)("a"), (0, gen_1.constant)("b"), (0, gen_1.constant)("c"));
    for (let i = 0; i < 100; i++) {
        assert.ok(["a", "b", "c"].includes(gen(rng, i).value));
    }
});
(0, node_test_1.default)("boolean shrinks true towards false", () => {
    const gen = (0, gen_1.boolean)();
    const rng = new rng_1.Rng(0);
    let sawTrueShrink = false;
    for (let i = 0; i < 50; i++) {
        const tree = gen(rng, i);
        if (tree.value === true) {
            const kids = [...tree.shrinks()];
            assert.equal(kids.length, 1);
            assert.equal(kids[0].value, false);
            sawTrueShrink = true;
        }
    }
    assert.ok(sawTrueShrink);
});
