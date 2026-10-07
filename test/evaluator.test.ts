import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  add,
  sub,
  mul,
  div,
  lit,
  v,
  letIn,
  bin,
  Evaluator,
  EvalDiagnostic,
  evaluateNaive,
  TraceEvent,
  Expr,
  BinOp,
} from "../src/index";

function capture(fn: () => number): EvalDiagnostic {
  try {
    fn();
  } catch (err) {
    if (err instanceof EvalDiagnostic) {
      return err;
    }
    throw new Error("expected an EvalDiagnostic");
  }
  throw new Error("expected the evaluation to throw");
}

test("integer arithmetic, including truncating division", () => {
  const ev = new Evaluator();
  assert.strictEqual(ev.evaluate(add(lit(2), mul(lit(3), lit(4)))), 14);
  assert.strictEqual(ev.evaluate(div(lit(7), lit(2))), 3);
  assert.strictEqual(ev.evaluate(div(lit(-7), lit(2))), -3);
  assert.strictEqual(ev.evaluate(sub(lit(5), lit(8))), -3);
});

test("let bindings are lazy: unused failing bindings are never forced", () => {
  const trace: TraceEvent[] = [];
  const ev = new Evaluator({ trace });
  const result = ev.evaluate(letIn("x", div(lit(1), lit(0)), lit(42)));
  assert.strictEqual(result, 42);
  assert.deepEqual(trace, []);
});

test("let bindings are shared: the bound expression is evaluated at most once", () => {
  const trace: TraceEvent[] = [];
  const ev = new Evaluator({ trace });
  const result = ev.evaluate(letIn("x", add(lit(2), lit(3)), mul(v("x"), v("x"))));
  assert.strictEqual(result, 25);
  assert.deepEqual(trace, [
    { type: "force", name: "x" },
    { type: "value", name: "x", value: 5 },
    { type: "cache-hit", name: "x", outcome: "value" },
  ]);
});

test("forcing order is observable through the trace", () => {
  const trace: TraceEvent[] = [];
  const ev = new Evaluator({ trace });
  const program = letIn(
    "a",
    lit(1),
    letIn("b", add(v("a"), lit(1)), add(v("b"), v("a"))),
  );
  assert.strictEqual(ev.evaluate(program), 3);
  assert.deepEqual(trace, [
    { type: "force", name: "b" },
    { type: "force", name: "a" },
    { type: "value", name: "a", value: 1 },
    { type: "value", name: "b", value: 2 },
    { type: "cache-hit", name: "a", outcome: "value" },
  ]);
});

test("self-dependent bindings report a black hole", () => {
  const trace: TraceEvent[] = [];
  const ev = new Evaluator({ trace });
  const err = capture(() => ev.evaluate(letIn("x", add(v("x"), lit(1)), v("x"))));
  assert.strictEqual(err.code, "BLACK_HOLE");
  assert.match(err.message, /black hole/);
  assert.match(err.message, /'x'/);
  assert.deepEqual(trace, [
    { type: "force", name: "x" },
    { type: "black-hole", name: "x" },
    { type: "failure", name: "x", code: "BLACK_HOLE" },
  ]);
});

test("mutually dependent nested bindings report a black hole", () => {
  const ev = new Evaluator();
  const program = letIn("x", letIn("y", v("x"), v("y")), v("x"));
  const err = capture(() => ev.evaluate(program));
  assert.strictEqual(err.code, "BLACK_HOLE");
});

test("first evaluation caches failures and replays the identical diagnostic", () => {
  const trace: TraceEvent[] = [];
  const ev = new Evaluator({ trace });
  ev.define("x", div(lit(1), lit(0)));

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

test("cached black-hole failures also replay the identical diagnostic", () => {
  const ev = new Evaluator();
  ev.define("x", v("x"));
  const first = capture(() => ev.force("x"));
  const second = capture(() => ev.force("x"));
  assert.strictEqual(first.code, "BLACK_HOLE");
  assert.strictEqual(first, second);
});

test("successful evaluation is cached and shared across top-level forces", () => {
  const trace: TraceEvent[] = [];
  const ev = new Evaluator({ trace });
  ev.define("x", add(lit(20), lit(22)));
  assert.strictEqual(ev.force("x"), 42);
  assert.strictEqual(ev.force("x"), 42);
  assert.deepEqual(trace, [
    { type: "force", name: "x" },
    { type: "value", name: "x", value: 42 },
    { type: "cache-hit", name: "x", outcome: "value" },
  ]);
});

test("budget is only charged for actually evaluated nodes", () => {
  // let x = 2 + 3 in x * x
  // charged nodes: let, mul, var x (forces), add, lit, lit = 6; the cached
  // second occurrence of x is free.
  const program = letIn("x", add(lit(2), lit(3)), mul(v("x"), v("x")));

  const enough = new Evaluator({ budget: 6 });
  assert.strictEqual(enough.evaluate(program), 25);
  assert.strictEqual(enough.spent, 6);

  const short = new Evaluator({ budget: 5 });
  const err = capture(() => short.evaluate(program));
  assert.strictEqual(err.code, "BUDGET_EXCEEDED");

  // An unused binding costs nothing beyond the let node itself.
  const lazy = new Evaluator({ budget: 2 });
  assert.strictEqual(lazy.evaluate(letIn("x", add(lit(1), lit(1)), lit(7))), 7);
  assert.strictEqual(lazy.spent, 2);
});

test("unbound variables are reported", () => {
  const ev = new Evaluator();
  const err = capture(() => ev.evaluate(v("ghost")));
  assert.strictEqual(err.code, "UNBOUND_VAR");
});

test("sharing reduces work compared to the non-shared interpreter", () => {
  // let x = 1 + 1 in x + x + x + x
  let body: Expr = v("x");
  for (let i = 0; i < 3; i += 1) {
    body = add(body, v("x"));
  }
  const program = letIn("x", add(lit(1), lit(1)), body);

  const shared = new Evaluator();
  assert.strictEqual(shared.evaluate(program), 8);

  const stats = { steps: 0 };
  assert.strictEqual(evaluateNaive(program, stats), 8);
  assert.ok(
    shared.spent < stats.steps,
    `shared spent ${shared.spent} should beat naive ${stats.steps}`,
  );
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function genExpr(
  rand: () => number,
  depth: number,
  scope: string[],
  fresh: { n: number },
): Expr {
  const pick = rand();
  if (depth <= 0 || pick < 0.3) {
    if (scope.length > 0 && rand() < 0.5) {
      return v(scope[Math.floor(rand() * scope.length)]);
    }
    return lit(Math.floor(rand() * 21) - 10);
  }
  if (pick < 0.55) {
    const ops: BinOp[] = ["add", "sub", "mul"];
    const op = ops[Math.floor(rand() * ops.length)];
    return bin(op, genExpr(rand, depth - 1, scope, fresh), genExpr(rand, depth - 1, scope, fresh));
  }
  if (pick < 0.7) {
    // Keep divisors non-zero literals so generated programs always terminate
    // with a value and can be cross-checked numerically.
    return div(genExpr(rand, depth - 1, scope, fresh), lit(1 + Math.floor(rand() * 5)));
  }
  const name = `g${fresh.n}`;
  fresh.n += 1;
  // The bound expression only sees the outer scope, so no self-dependency.
  const value = genExpr(rand, depth - 1, scope, fresh);
  const body = genExpr(rand, depth - 1, [...scope, name], fresh);
  return letIn(name, value, body);
}

test("shared evaluator agrees with the non-shared interpreter on generated programs", () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const rand = mulberry32(seed);
    const program = genExpr(rand, 5, [], { n: 0 });

    const shared = new Evaluator();
    const sharedResult = shared.evaluate(program);

    const stats = { steps: 0 };
    const naiveResult = evaluateNaive(program, stats);

    assert.strictEqual(sharedResult, naiveResult, `seed ${seed}`);
    assert.ok(
      shared.spent <= stats.steps,
      `seed ${seed}: shared spent ${shared.spent} > naive steps ${stats.steps}`,
    );
  }
});
