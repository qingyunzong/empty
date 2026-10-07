import { test } from "node:test";
import assert from "node:assert/strict";
import { E } from "../src/ast.ts";
import {
  evaluate,
  run,
  InterpretedError,
  type TraceEvent,
} from "../src/interpreter.ts";

function frameIdOf(trace: TraceEvent[], name: string): number {
  const event = trace.find((e) => e.type === "enter" && e.name === name);
  assert.ok(event, `expected enter event for ${name}`);
  return event.frameId;
}

test("arithmetic, let and if evaluate correctly", () => {
  assert.equal(evaluate(E.add(E.num(2), E.mul(E.num(3), E.num(4)))), 14);
  assert.equal(
    evaluate(E.let("x", E.num(10), E.if(E.lt(E.var("x"), E.num(5)), E.num(1), E.num(2)))),
    2,
  );
});

test("closures capture their defining environment", () => {
  const prog = E.let(
    "x",
    E.num(1),
    E.let(
      "f",
      E.fun(null, ["y"], E.add(E.var("x"), E.var("y"))),
      E.let("x", E.num(10), E.call(E.var("f"), E.num(5))),
    ),
  );
  assert.equal(evaluate(prog), 6);
});

test("frame meter counts nested non-tail calls exactly", () => {
  const prog = E.let(
    "h",
    E.fun("h", ["x"], E.add(E.var("x"), E.num(1))),
    E.let(
      "g",
      E.fun("g", ["x"], E.add(E.call(E.var("h"), E.var("x")), E.num(1))),
      E.let(
        "f",
        E.fun("f", ["x"], E.add(E.call(E.var("g"), E.var("x")), E.num(1))),
        E.call(E.var("f"), E.num(0)),
      ),
    ),
  );
  const result = run(prog);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value, 3);
  assert.equal(result.meter.allocated, 3);
  assert.equal(result.meter.maxLive, 3);
  assert.equal(result.meter.live, 0);
  assert.equal(result.meter.reused, 0);
});

test("deep non-tail recursion does not overflow the host stack", () => {
  const depth = 20000;
  const prog = E.call(
    E.fun(
      "sum",
      ["n"],
      E.if(
        E.eq(E.var("n"), E.num(0)),
        E.num(0),
        E.add(E.var("n"), E.call(E.var("sum"), E.sub(E.var("n"), E.num(1)))),
      ),
    ),
    E.num(depth),
  );
  const result = run(prog);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value, (depth * (depth + 1)) / 2);
  assert.equal(result.meter.maxLive, depth + 1);
  assert.equal(result.meter.allocated, depth + 1);
  assert.equal(result.meter.reused, 0);
});

test("tail calls reuse the frame so depth stays constant", () => {
  const depth = 200000;
  const prog = E.call(
    E.fun(
      "loop",
      ["n", "acc"],
      E.if(
        E.eq(E.var("n"), E.num(0)),
        E.var("acc"),
        E.call(
          E.var("loop"),
          E.sub(E.var("n"), E.num(1)),
          E.add(E.var("acc"), E.var("n")),
        ),
      ),
    ),
    E.num(depth),
    E.num(0),
  );
  const result = run(prog);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value, (depth * (depth + 1)) / 2);
  assert.equal(result.meter.allocated, 1);
  assert.equal(result.meter.reused, depth);
  assert.equal(result.meter.maxLive, 1);
});

test("a pending finally disables tail-call frame reuse", () => {
  const prog = E.call(
    E.fun(
      "f",
      ["n"],
      E.try(
        E.call(E.fun("g", ["x"], E.add(E.var("x"), E.num(1))), E.var("n")),
        { finallyBody: E.num(0) },
      ),
    ),
    E.num(10),
  );
  const result = run(prog);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value, 11);
  assert.equal(result.meter.reused, 0);
  assert.equal(result.meter.allocated, 2);
  assert.equal(result.meter.maxLive, 2);

  const fId = frameIdOf(result.trace, "f");
  const gId = frameIdOf(result.trace, "g");
  const kinds = result.trace.map((e) => e.type);
  assert.deepEqual(kinds, ["enter", "enter", "exit", "finally", "exit"]);
  const finallyEvent = result.trace.find((e) => e.type === "finally");
  assert.ok(finallyEvent);
  assert.equal(finallyEvent.frameId, fId);
  assert.notEqual(finallyEvent.frameId, gId);
});

test("exceptions unwind frames innermost-first with explicit frame references", () => {
  const prog = E.let(
    "inner",
    E.fun("inner", ["x"], E.throw(E.var("x"))),
    E.let(
      "middle",
      E.fun(
        "middle",
        ["x"],
        E.try(E.call(E.var("inner"), E.var("x")), { finallyBody: E.num(0) }),
      ),
      E.let(
        "outer",
        E.fun(
          "outer",
          ["x"],
          E.try(E.call(E.var("middle"), E.var("x")), { finallyBody: E.num(0) }),
        ),
        E.call(E.var("outer"), E.num(42)),
      ),
    ),
  );
  const result = run(prog);
  assert.equal(result.status, "throw");
  if (result.status !== "throw") return;
  assert.equal(result.error.value, 42);

  const outerId = frameIdOf(result.trace, "outer");
  const middleId = frameIdOf(result.trace, "middle");
  const innerId = frameIdOf(result.trace, "inner");

  assert.deepEqual(result.error.frames, [innerId, middleId, outerId]);

  const unwindIds = result.trace.filter((e) => e.type === "unwind").map((e) => e.frameId);
  assert.deepEqual(unwindIds, [innerId, middleId, outerId]);

  const finallyIds = result.trace.filter((e) => e.type === "finally").map((e) => e.frameId);
  assert.deepEqual(finallyIds, [middleId, outerId]);
});

test("catch handles the exception and finally still runs afterwards", () => {
  const prog = E.try(E.throw(E.num(5)), {
    catchParam: "e",
    catchBody: E.add(E.var("e"), E.num(1)),
    finallyBody: E.num(0),
  });
  const result = run(prog);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value, 6);
  const kinds = result.trace.map((e) => e.type);
  assert.deepEqual(kinds, ["catch", "finally"]);
});

test("a throwing finally overrides a pending exception", () => {
  const result = run(
    E.try(E.throw(E.num(1)), { finallyBody: E.throw(E.num(2)) }),
  );
  assert.equal(result.status, "throw");
  if (result.status !== "throw") return;
  assert.equal(result.error.value, 2);
});

test("a throwing finally overrides a normal result", () => {
  const result = run(E.try(E.num(7), { finallyBody: E.throw(E.num(9)) }));
  assert.equal(result.status, "throw");
  if (result.status !== "throw") return;
  assert.equal(result.error.value, 9);
});

test("a non-throwing finally preserves the original result", () => {
  const result = run(E.try(E.num(7), { finallyBody: E.num(9) }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.value, 7);
});

test("evaluate throws InterpretedError carrying the unwound frames", () => {
  const prog = E.call(E.fun("boom", ["x"], E.throw(E.var("x"))), E.num(3));
  assert.throws(
    () => evaluate(prog),
    (err: unknown) => {
      assert.ok(err instanceof InterpretedError);
      assert.equal(err.thrown.value, 3);
      assert.equal(err.thrown.frames.length, 1);
      return true;
    },
  );
});
