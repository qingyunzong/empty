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
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const assert = __importStar(require("node:assert/strict"));
const index_1 = require("../src/index");
function capture(fn) {
    try {
        fn();
    }
    catch (err) {
        if (err instanceof index_1.EvalDiagnostic) {
            return err;
        }
        throw new Error("expected an EvalDiagnostic");
    }
    throw new Error("expected the evaluation to throw");
}
(0, node_test_1.test)("integer arithmetic, including truncating division", () => {
    const ev = new index_1.Evaluator();
    assert.strictEqual(ev.evaluate((0, index_1.add)((0, index_1.lit)(2), (0, index_1.mul)((0, index_1.lit)(3), (0, index_1.lit)(4)))), 14);
    assert.strictEqual(ev.evaluate((0, index_1.div)((0, index_1.lit)(7), (0, index_1.lit)(2))), 3);
    assert.strictEqual(ev.evaluate((0, index_1.div)((0, index_1.lit)(-7), (0, index_1.lit)(2))), -3);
    assert.strictEqual(ev.evaluate((0, index_1.sub)((0, index_1.lit)(5), (0, index_1.lit)(8))), -3);
});
(0, node_test_1.test)("let bindings are lazy: unused failing bindings are never forced", () => {
    const trace = [];
    const ev = new index_1.Evaluator({ trace });
    const result = ev.evaluate((0, index_1.letIn)("x", (0, index_1.div)((0, index_1.lit)(1), (0, index_1.lit)(0)), (0, index_1.lit)(42)));
    assert.strictEqual(result, 42);
    assert.deepEqual(trace, []);
});
(0, node_test_1.test)("let bindings are shared: the bound expression is evaluated at most once", () => {
    const trace = [];
    const ev = new index_1.Evaluator({ trace });
    const result = ev.evaluate((0, index_1.letIn)("x", (0, index_1.add)((0, index_1.lit)(2), (0, index_1.lit)(3)), (0, index_1.mul)((0, index_1.v)("x"), (0, index_1.v)("x"))));
    assert.strictEqual(result, 25);
    assert.deepEqual(trace, [
        { type: "force", name: "x" },
        { type: "value", name: "x", value: 5 },
        { type: "cache-hit", name: "x", outcome: "value" },
    ]);
});
(0, node_test_1.test)("forcing order is observable through the trace", () => {
    const trace = [];
    const ev = new index_1.Evaluator({ trace });
    const program = (0, index_1.letIn)("a", (0, index_1.lit)(1), (0, index_1.letIn)("b", (0, index_1.add)((0, index_1.v)("a"), (0, index_1.lit)(1)), (0, index_1.add)((0, index_1.v)("b"), (0, index_1.v)("a"))));
    assert.strictEqual(ev.evaluate(program), 3);
    assert.deepEqual(trace, [
        { type: "force", name: "b" },
        { type: "force", name: "a" },
        { type: "value", name: "a", value: 1 },
        { type: "value", name: "b", value: 2 },
        { type: "cache-hit", name: "a", outcome: "value" },
    ]);
});
(0, node_test_1.test)("self-dependent bindings report a black hole", () => {
    const trace = [];
    const ev = new index_1.Evaluator({ trace });
    const err = capture(() => ev.evaluate((0, index_1.letIn)("x", (0, index_1.add)((0, index_1.v)("x"), (0, index_1.lit)(1)), (0, index_1.v)("x"))));
    assert.strictEqual(err.code, "BLACK_HOLE");
    assert.match(err.message, /black hole/);
    assert.match(err.message, /'x'/);
    assert.deepEqual(trace, [
        { type: "force", name: "x" },
        { type: "black-hole", name: "x" },
        { type: "failure", name: "x", code: "BLACK_HOLE" },
    ]);
});
(0, node_test_1.test)("mutually dependent nested bindings report a black hole", () => {
    const ev = new index_1.Evaluator();
    const program = (0, index_1.letIn)("x", (0, index_1.letIn)("y", (0, index_1.v)("x"), (0, index_1.v)("y")), (0, index_1.v)("x"));
    const err = capture(() => ev.evaluate(program));
    assert.strictEqual(err.code, "BLACK_HOLE");
});
(0, node_test_1.test)("first evaluation caches failures and replays the identical diagnostic", () => {
    const trace = [];
    const ev = new index_1.Evaluator({ trace });
    ev.define("x", (0, index_1.div)((0, index_1.lit)(1), (0, index_1.lit)(0)));
    const first = capture(() => ev.force("x"));
    const second = capture(() => ev.force("x"));
    assert.strictEqual(first.code, "DIV_BY_ZERO");
    assert.strictEqual(first, second);
    assert.deepEqual(trace, [
        { type: "force", name: "x" },
        { type: "failure", name: "x", code: "DIV_BY_ZERO" },
        { type: "cache-hit", name: "x", outcome: "failure" },
    ]);
});
(0, node_test_1.test)("cached black-hole failures also replay the identical diagnostic", () => {
    const ev = new index_1.Evaluator();
    ev.define("x", (0, index_1.v)("x"));
    const first = capture(() => ev.force("x"));
    const second = capture(() => ev.force("x"));
    assert.strictEqual(first.code, "BLACK_HOLE");
    assert.strictEqual(first, second);
});
(0, node_test_1.test)("successful evaluation is cached and shared across top-level forces", () => {
    const trace = [];
    const ev = new index_1.Evaluator({ trace });
    ev.define("x", (0, index_1.add)((0, index_1.lit)(20), (0, index_1.lit)(22)));
    assert.strictEqual(ev.force("x"), 42);
    assert.strictEqual(ev.force("x"), 42);
    assert.deepEqual(trace, [
        { type: "force", name: "x" },
        { type: "value", name: "x", value: 42 },
        { type: "cache-hit", name: "x", outcome: "value" },
    ]);
});
(0, node_test_1.test)("budget is only charged for actually evaluated nodes", () => {
    // let x = 2 + 3 in x * x
    // charged nodes: let, mul, var x (forces), add, lit, lit = 6; the cached
    // second occurrence of x is free.
    const program = (0, index_1.letIn)("x", (0, index_1.add)((0, index_1.lit)(2), (0, index_1.lit)(3)), (0, index_1.mul)((0, index_1.v)("x"), (0, index_1.v)("x")));
    const enough = new index_1.Evaluator({ budget: 6 });
    assert.strictEqual(enough.evaluate(program), 25);
    assert.strictEqual(enough.spent, 6);
    const short = new index_1.Evaluator({ budget: 5 });
    const err = capture(() => short.evaluate(program));
    assert.strictEqual(err.code, "BUDGET_EXCEEDED");
    // An unused binding costs nothing beyond the let node itself.
    const lazy = new index_1.Evaluator({ budget: 2 });
    assert.strictEqual(lazy.evaluate((0, index_1.letIn)("x", (0, index_1.add)((0, index_1.lit)(1), (0, index_1.lit)(1)), (0, index_1.lit)(7))), 7);
    assert.strictEqual(lazy.spent, 2);
});
(0, node_test_1.test)("unbound variables are reported", () => {
    const ev = new index_1.Evaluator();
    const err = capture(() => ev.evaluate((0, index_1.v)("ghost")));
    assert.strictEqual(err.code, "UNBOUND_VAR");
});
(0, node_test_1.test)("sharing reduces work compared to the non-shared interpreter", () => {
    // let x = 1 + 1 in x + x + x + x
    let body = (0, index_1.v)("x");
    for (let i = 0; i < 3; i += 1) {
        body = (0, index_1.add)(body, (0, index_1.v)("x"));
    }
    const program = (0, index_1.letIn)("x", (0, index_1.add)((0, index_1.lit)(1), (0, index_1.lit)(1)), body);
    const shared = new index_1.Evaluator();
    assert.strictEqual(shared.evaluate(program), 8);
    const stats = { steps: 0 };
    assert.strictEqual((0, index_1.evaluateNaive)(program, stats), 8);
    assert.ok(shared.spent < stats.steps, `shared spent ${shared.spent} should beat naive ${stats.steps}`);
});
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
function genExpr(rand, depth, scope, fresh) {
    const pick = rand();
    if (depth <= 0 || pick < 0.3) {
        if (scope.length > 0 && rand() < 0.5) {
            return (0, index_1.v)(scope[Math.floor(rand() * scope.length)]);
        }
        return (0, index_1.lit)(Math.floor(rand() * 21) - 10);
    }
    if (pick < 0.55) {
        const ops = ["add", "sub", "mul"];
        const op = ops[Math.floor(rand() * ops.length)];
        return (0, index_1.bin)(op, genExpr(rand, depth - 1, scope, fresh), genExpr(rand, depth - 1, scope, fresh));
    }
    if (pick < 0.7) {
        // Keep divisors non-zero literals so generated programs always terminate
        // with a value and can be cross-checked numerically.
        return (0, index_1.div)(genExpr(rand, depth - 1, scope, fresh), (0, index_1.lit)(1 + Math.floor(rand() * 5)));
    }
    const name = `g${fresh.n}`;
    fresh.n += 1;
    // The bound expression only sees the outer scope, so no self-dependency.
    const value = genExpr(rand, depth - 1, scope, fresh);
    const body = genExpr(rand, depth - 1, [...scope, name], fresh);
    return (0, index_1.letIn)(name, value, body);
}
(0, node_test_1.test)("shared evaluator agrees with the non-shared interpreter on generated programs", () => {
    for (let seed = 1; seed <= 500; seed += 1) {
        const rand = mulberry32(seed);
        const program = genExpr(rand, 5, [], { n: 0 });
        const shared = new index_1.Evaluator();
        const sharedResult = shared.evaluate(program);
        const stats = { steps: 0 };
        const naiveResult = (0, index_1.evaluateNaive)(program, stats);
        assert.strictEqual(sharedResult, naiveResult, `seed ${seed}`);
        assert.ok(shared.spent <= stats.steps, `seed ${seed}: shared spent ${shared.spent} > naive steps ${stats.steps}`);
    }
});
