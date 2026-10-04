import { test } from "node:test";
import * as assert from "node:assert/strict";
import { runEventLoop } from "../src/simulator.ts";
import { deserializeTrace, replay, serializeTrace, traceEquals } from "../src/trace.ts";
import { allExamples, microChain, microLoopUnclosed } from "../src/examples.ts";

test("轨迹序列化/反序列化往返一致", () => {
  for (const example of allExamples) {
    const result = runEventLoop(example.setup, { stepBudget: example.stepBudget });
    const roundTripped = deserializeTrace(serializeTrace(result.trace));
    assert.ok(traceEquals(roundTripped, result.trace), example.name);
  }
});

test("同一程序重放轨迹完全一致（含未闭合情形）", () => {
  const closed = runEventLoop(microChain.setup, { stepBudget: microChain.stepBudget });
  const replayed = replay(microChain.setup, microChain.stepBudget, closed.trace);
  assert.equal(replayed.status, "closed");

  const unclosed = runEventLoop(microLoopUnclosed.setup, {
    stepBudget: microLoopUnclosed.stepBudget,
  });
  const replayedUnclosed = replay(
    microLoopUnclosed.setup,
    microLoopUnclosed.stepBudget,
    unclosed.trace,
  );
  assert.equal(replayedUnclosed.status, "exhausted");
});

test("重复运行结果确定（同一程序两次运行轨迹相同）", () => {
  for (const example of allExamples) {
    const first = runEventLoop(example.setup, { stepBudget: example.stepBudget });
    const second = runEventLoop(example.setup, { stepBudget: example.stepBudget });
    assert.ok(traceEquals(first.trace, second.trace), example.name);
    assert.equal(first.status, second.status, example.name);
  }
});

test("重放不匹配的轨迹会抛错", () => {
  const result = runEventLoop(microChain.setup, { stepBudget: microChain.stepBudget });
  const tampered = result.trace.map((event) => ({ ...event }));
  const first = tampered[0];
  if (first === undefined) throw new Error("trace should not be empty");
  first.id = "tampered";
  assert.throws(() => replay(microChain.setup, microChain.stepBudget, tampered));
});
