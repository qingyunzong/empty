import { test } from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/runtime.js";
import { runScenario } from "../src/scenario.js";

test("in-order round: drains stream and closes with exit code", async () => {
  const runtime = new Runtime();
  const round = runtime.startRound("w");
  round.write("hello ");
  round.write("world");
  round.assert("invariant holds");
  round.exit(0);
  const final = await round.end();
  assert.equal(final.status, "closed-drained");
  assert.equal(final.exitCode, 0);
  assert.equal(final.stdout, "hello world");
  assert.deepEqual(final.assertions, ["invariant holds"]);
});

test("end() waits for stream drain before closing", async () => {
  const runtime = new Runtime();
  const round = runtime.startRound("w");
  round.write("pending-chunk");
  const endPromise = round.end();
  assert.equal(runtime.getRound("w", 1)?.phase, "draining");
  assert.equal(runtime.getRound("w", 1)?.finalState, null);
  const final = await endPromise;
  assert.equal(final.status, "closed-drained");
  assert.equal(final.stdout, "pending-chunk");
});

test("explicit truncation closes immediately and discards pending output", async () => {
  const runtime = new Runtime();
  const round = runtime.startRound("w");
  round.write("lost-data");
  const truncated = round.truncate("operator kill");
  assert.equal(truncated, true);
  const final = await round.end();
  assert.equal(final.status, "closed-truncated");
  assert.equal(final.stdout, "");
  assert.equal(final.truncatedBytes, "lost-data".length);
  assert.equal(final.truncateReason, "operator kill");
  assert.equal(round.truncate("again"), false, "closed round cannot truncate again");
});

test("late stdout/assert/exit are attributed only to their original round", async () => {
  const runtime = new Runtime();
  const gen1 = runtime.startRound("A");
  gen1.write("gen1-out;");
  gen1.exit(0);
  const gen1Final = await gen1.end();
  const snapshot = JSON.parse(JSON.stringify(gen1Final));

  const gen2 = runtime.startRound("A");
  const lateWrite = gen1.write("late-out;");
  const lateAssert = gen1.assert("late-assert");
  const lateExit = gen1.exit(9);
  assert.equal(lateWrite.disposition, "late");
  assert.equal(lateAssert.disposition, "late");
  assert.equal(lateExit.disposition, "late");

  gen2.write("gen2-out;");
  gen2.exit(0);
  const gen2Final = await gen2.end();

  assert.equal(gen2Final.stdout, "gen2-out;", "new generation untouched by late writes");
  assert.deepEqual(gen2Final.assertions, [], "new generation untouched by late asserts");
  assert.deepEqual(
    JSON.parse(JSON.stringify(gen1Final)),
    snapshot,
    "closed round final state is unique and immutable",
  );
  assert.equal(gen1Final.exitCode, 0, "late exit does not overwrite exit code");

  const gen1View = runtime.getRound("A", 1);
  assert.equal(gen1View?.evidence.filter((e) => e.disposition === "late").length, 3);
});

test("stale handle can never write into a newer generation", async () => {
  const runtime = new Runtime();
  const gen1 = runtime.startRound("A");
  gen1.exit(0);
  await gen1.end();
  const gen2 = runtime.startRound("A");
  gen1.write("stale");
  gen2.write("fresh;");
  const gen2Final = await gen2.end();
  assert.equal(gen2Final.stdout, "fresh;");
  const gen2View = runtime.getRound("A", 2);
  assert.equal(
    gen2View?.evidence.every((e) => e.message.generation === 2),
    true,
    "generation 2 only carries generation-2 evidence",
  );
});

test("messages for a non-existent round are rejected", () => {
  const runtime = new Runtime();
  const evidence = runtime.dispatch({
    slot: "ghost",
    generation: 1,
    type: "stdout",
    payload: "boo",
    emitSeq: 1,
  });
  assert.equal(evidence.disposition, "rejected");
  assert.match(evidence.reason, /does not exist/);
});

test("evidence log is complete with strictly increasing arrival sequence", async () => {
  const { runtime } = await runScenario(42);
  assert.ok(runtime.log.length > 0);
  runtime.log.forEach((entry, index) => {
    assert.equal(entry.arrivalSeq, index + 1);
  });
  const total = runtime.log.length;
  const perRound = runtime
    .listRounds()
    .reduce((count, view) => count + view.evidence.length, 0);
  assert.equal(perRound, total, "every dispatched message is cited exactly once");
});

test("out-of-order delivery: same seed yields identical unique final states", async () => {
  const first = await runScenario(42);
  const second = await runScenario(42);
  assert.deepEqual(first.finalStates, second.finalStates);
  assert.equal(first.finalStates.a1.status, "closed-drained");
  assert.equal(first.finalStates.b1.status, "closed-truncated");
  assert.equal(first.finalStates.a2.status, "closed-drained");
  assert.equal(first.finalStates.a2.stdout, "A2-out-1;");
});

test("out-of-order delivery: shuffled emit order is visible in citations, not in terminal status", async () => {
  const inOrder = await runScenario(null);
  const shuffled = await runScenario(7);
  assert.equal(shuffled.finalStates.a1.status, inOrder.finalStates.a1.status);
  assert.equal(shuffled.finalStates.a1.exitCode, inOrder.finalStates.a1.exitCode);
  assert.deepEqual(
    shuffled.finalStates.a1.assertions,
    inOrder.finalStates.a1.assertions,
  );
  const emitOrder = shuffled.runtime.log
    .filter((e) => e.message.slot === "A" && e.message.generation === 1 && e.disposition === "applied")
    .map((e) => e.message.emitSeq);
  assert.notDeepEqual(emitOrder, [1, 2, 3, 4, 5], "delivery was actually out of order");
});

test("closed round final state never mutates under late traffic", async () => {
  const { runtime, finalStates } = await runScenario(99);
  const before = JSON.stringify(finalStates.a1);
  const staleView = runtime.getRound("A", 1);
  assert.ok(staleView);
  for (let i = 0; i < 5; i++) {
    runtime.dispatch({
      slot: "A",
      generation: 1,
      type: "stdout",
      payload: `extra-${i};`,
      emitSeq: 100 + i,
    });
  }
  assert.equal(JSON.stringify(runtime.getRound("A", 1)?.finalState), before);
  assert.equal(
    runtime.getRound("A", 1)?.evidence.filter((e) => e.disposition === "late").length,
    3 + 5,
    "all late messages are cited on the original round",
  );
});
