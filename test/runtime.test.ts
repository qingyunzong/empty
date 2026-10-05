import test from "node:test";
import assert from "node:assert/strict";
import { Runtime } from "../src/runtime.js";
import { runSimulation } from "../src/simulate.js";

test("round end waits for stream drain before completing", () => {
  const rt = new Runtime();
  const h = rt.beginRound();
  h.writeStdout("partial ", false);
  h.exit(0);
  rt.endRound();
  rt.transport.deliverAll((m) => rt.receive(m));
  const round = rt.roundById("round-1")!;
  assert.equal(round.phase, "closing", "stdout final chunk missing: must keep waiting");
  assert.equal(round.terminalState, null);

  // Late final chunk arrives -> drain condition met -> completed.
  rt.receive({
    kind: "stdout",
    messageId: "r1:stdout:late-final",
    roundId: "round-1",
    generation: 1,
    seq: 99,
    chunk: "done\n",
    final: true,
  });
  assert.equal(round.terminalState, "completed");
});

test("explicit truncation terminates a round that cannot drain", () => {
  const rt = new Runtime();
  const h = rt.beginRound();
  h.writeStdout("never-finished ", false);
  rt.endRound();
  rt.transport.deliverAll((m) => rt.receive(m));
  assert.equal(rt.roundById("round-1")!.phase, "closing");
  assert.ok(rt.truncate("worker unresponsive"));
  assert.equal(rt.roundById("round-1")!.terminalState, "truncated");
});

test("late stdout/assertion/exit are attributed only to their original round", () => {
  const { runtime } = runSimulation();
  const r1 = runtime.roundById("round-1")!;
  const r2 = runtime.roundById("round-2")!;

  // Round-1's late messages are filed on round-1, not round-2.
  assert.ok(r1.lateMessageIds.length > 0, "expected late messages on round-1");
  for (const id of r1.lateMessageIds) assert.ok(id.startsWith("r1:"), `${id} belongs to gen 1`);
  assert.equal(r2.lateMessageIds.length, 0);

  // Round-2 state contains only round-2 data.
  for (const chunk of r2.stdout) assert.ok(chunk.chunk.startsWith("r2-"), chunk.chunk);
  for (const a of r2.assertions) assert.ok(a.name.startsWith("r2:"), a.name);

  // Every late-attributed evidence entry cites a round-1 message on round-1.
  const late = runtime.evidence.all().filter((e) => e.disposition === "late-attributed");
  assert.ok(late.length > 0);
  for (const e of late) {
    assert.equal(e.roundId, "round-1");
    assert.equal(e.generation, 1);
    assert.ok(e.messageId!.startsWith("r1:"));
  }
  // Late kinds cover stdout, assertion and exit.
  const kinds = new Set(late.map((e) => e.event));
  assert.deepEqual([...kinds].sort(), ["assertion", "exit", "stdout"]);
});

test("a closed generation cannot write into a new round", () => {
  const { runtime } = runSimulation();
  const rejected = runtime.evidence.all().filter((e) => e.disposition === "rejected-stale-handle");
  assert.equal(rejected.length, 2, "stale gen-1 handle wrote twice after close");
  for (const e of rejected) {
    assert.equal(e.roundId, "round-1");
    assert.ok(e.detail.includes("round-2"), "evidence must cite the protected new round");
  }
  // The stale payload never appears in round-2 (or anywhere as accepted state).
  const r2 = runtime.roundById("round-2")!;
  assert.ok(!r2.stdout.some((c) => c.chunk.includes("STALE-WRITE")));
  assert.ok(!r2.assertions.some((a) => a.name.includes("late direct assert")));
});

test("each round has exactly one terminal state", () => {
  const { runtime, summaries } = runSimulation();
  for (const round of runtime.allRounds()) {
    const terminals = runtime.evidence
      .forRound(round.id)
      .filter((e) => e.disposition === "state-transition" && e.detail.startsWith("terminal:"));
    assert.equal(terminals.length, 1, `${round.id} must have exactly one terminal transition`);
    assert.ok(round.terminalState !== null);
  }
  assert.equal(summaries.length, 2);
  assert.equal(summaries[0]!.terminalState, "truncated");
  assert.equal(summaries[1]!.terminalState, "completed");
  // The duplicate termination attempt was rejected and logged.
  assert.equal(runtime.evidence.count("rejected-duplicate-terminal"), 1);
});

test("out-of-order simulation emits complete citation evidence", () => {
  const result = runSimulation(42);
  console.log("\n" + result.report + "\n");

  const entries = result.evidence.all();
  // Citation ids are dense and ordered: E1..En.
  entries.forEach((e, i) => assert.equal(e.eid, `E${i + 1}`));
  // Every accepted/late message is citable.
  for (const e of entries) {
    if (e.disposition === "accepted" || e.disposition === "late-attributed") {
      assert.ok(e.messageId, `${e.eid} must cite a message id`);
    }
  }
  // Determinism: same seed -> identical evidence.
  const again = runSimulation(42);
  assert.deepEqual(
    again.evidence.all().map((e) => [e.eid, e.messageId, e.disposition]),
    entries.map((e) => [e.eid, e.messageId, e.disposition]),
  );
  // Unknown-round message is dropped with evidence, not silently.
  assert.equal(result.evidence.count("dropped-unknown-round"), 1);
});
