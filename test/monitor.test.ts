import { test } from "node:test";
import {
  deepEqual,
  equal,
  ok,
  throws,
} from "node:assert/strict";
import {
  Monitor,
  compileCondition,
  compileConditions,
  monitorFor,
  type InstanceView,
  type Outcome,
} from "../src/index.js";

const SPEC = { name: "A-then-B-no-C", trigger: "A", windowTicks: 3, require: ["B"], forbid: ["C"] } as const;

function summarize(views: readonly InstanceView[]): unknown[] {
  return views.map((v) => ({
    id: v.id,
    condition: v.condition,
    bornTick: v.bornTick,
    deadline: v.deadline,
    remainingTicks: v.remainingTicks,
    seenRequired: v.seenRequired,
    status: v.status,
  }));
}

test("compile: validates specs and freezes the result", () => {
  const cond = compileCondition(SPEC);
  equal(cond.name, "A-then-B-no-C");
  equal(cond.windowTicks, 3);
  deepEqual(cond.require, ["B"]);
  deepEqual(cond.forbid, ["C"]);
  throws(() => compileCondition({ trigger: "A", windowTicks: 0 }), /windowTicks/);
  throws(() => compileCondition({ trigger: "", windowTicks: 1 }), /trigger/);
  throws(
    () => compileCondition({ trigger: "A", windowTicks: 2, require: ["B"], forbid: ["B"] }),
    /both required and forbidden/,
  );
  throws(
    () => compileConditions([SPEC, SPEC]),
    /unique/,
  );
});

test("match: B within d ticks after A and no C produces match evidence at the deadline", () => {
  const mon = monitorFor(SPEC);
  deepEqual(mon.step(["A"]), []); // tick 1: instance born, window (1, 4]
  deepEqual(mon.step(["B"]), []); // tick 2: B observed, still pending (no-C must hold to deadline)
  deepEqual(mon.step([]), []); // tick 3
  const outcomes = mon.step([]); // tick 4: deadline reached
  equal(outcomes.length, 1);
  deepEqual(outcomes[0], {
    kind: "match",
    instanceId: 1,
    condition: "A-then-B-no-C",
    tick: 4,
    window: [1, 4],
    evidence: { required: { B: 2 } },
  });
  deepEqual(mon.enumerate(), []);
});

test("violation: missing required event is reported at the deadline with evidence", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // tick 1
  mon.advance(2); // ticks 2..3
  const outcomes = mon.step([]); // tick 4: deadline
  deepEqual(outcomes, [
    {
      kind: "violation",
      reason: "missing-required",
      instanceId: 1,
      condition: "A-then-B-no-C",
      tick: 4,
      missing: ["B"],
      window: [1, 4],
    },
  ]);
});

test("violation: forbidden C closes the instance immediately at C's tick", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // tick 1
  mon.step(["B"]); // tick 2
  const outcomes = mon.step(["C"]); // tick 3: C inside window
  deepEqual(outcomes, [
    {
      kind: "violation",
      reason: "forbidden-event",
      instanceId: 1,
      condition: "A-then-B-no-C",
      tick: 3,
      event: "C",
      window: [1, 4],
    },
  ]);
  deepEqual(mon.enumerate(), []); // instance is gone before its deadline
  deepEqual(mon.step([]), []); // tick 4: nothing left to resolve
});

test("multiple A events each spawn their own instance with independent outcomes", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // tick 1 -> instance 1, deadline 4
  mon.step(["A"]); // tick 2 -> instance 2, deadline 5
  mon.step(["B"]); // tick 3: B counts for BOTH live instances
  const t4 = mon.step([]); // tick 4: instance 1 resolves
  const t5 = mon.step([]); // tick 5: instance 2 resolves
  equal(t4.length, 1);
  equal(t5.length, 1);
  equal(t4[0]!.kind, "match");
  equal(t4[0]!.instanceId, 1);
  equal(t5[0]!.kind, "match");
  equal(t5[0]!.instanceId, 2);
});

test("cancel removes only the instance with the matching id", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // tick 1 -> instance 1
  mon.step(["A"]); // tick 2 -> instance 2
  equal(mon.cancel(1), true);
  equal(mon.cancel(1), false); // already gone
  equal(mon.cancel(999), false); // unknown id
  deepEqual(
    mon.enumerate().map((v) => v.id),
    [2],
  );
  const outcomes = mon.advance(3); // ticks 3..5: only instance 2 resolves
  equal(outcomes.length, 1);
  equal(outcomes[0]!.instanceId, 2);
  equal(outcomes[0]!.kind, "violation"); // B never arrived for instance 2
});

test("same-tick inputs are processed before timeouts (B on the deadline tick counts)", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // tick 1, deadline = 4
  mon.advance(2); // ticks 2..3
  const outcomes = mon.step(["B"]); // tick 4: B arrives exactly on the deadline tick
  equal(outcomes.length, 1);
  equal(outcomes[0]!.kind, "match");
  deepEqual((outcomes[0] as { evidence: { required: Record<string, number> } }).evidence.required, { B: 4 });
});

test("same-tick forbidden event beats the timeout (C on the deadline tick violates)", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // tick 1
  mon.step(["B"]); // tick 2
  mon.step([]); // tick 3
  const outcomes = mon.step(["C"]); // tick 4: C lands on the deadline tick
  equal(outcomes.length, 1);
  equal(outcomes[0]!.kind, "violation");
  equal((outcomes[0] as { reason: string }).reason, "forbidden-event");
});

test("events on the trigger tick itself are outside the window (t, t+d]", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A", "B"]); // tick 1: B is simultaneous with A, not "after A"
  const outcomes = mon.advance(3); // ticks 2..4
  equal(outcomes.length, 1);
  equal(outcomes[0]!.kind, "violation");
  equal((outcomes[0] as { reason: string }).reason, "missing-required");
});

test("per-tick instance enumeration matches the expected table", () => {
  const mon = monitorFor(SPEC);
  const trace: { tick: number; outcomes: Outcome[]; instances: unknown[] }[] = [];
  const script: string[][] = [
    ["A"], // tick 1
    ["A", "B"], // tick 2
    [], // tick 3
    ["C"], // tick 4
    [], // tick 5
  ];
  for (const events of script) {
    const outcomes = mon.step(events);
    trace.push({ tick: mon.tick, outcomes, instances: summarize(mon.enumerate()) });
  }
  deepEqual(trace, [
    {
      tick: 1,
      outcomes: [],
      instances: [
        { id: 1, condition: "A-then-B-no-C", bornTick: 1, deadline: 4, remainingTicks: 3, seenRequired: {}, status: "pending" },
      ],
    },
    {
      tick: 2,
      outcomes: [],
      instances: [
        { id: 1, condition: "A-then-B-no-C", bornTick: 1, deadline: 4, remainingTicks: 2, seenRequired: { B: 2 }, status: "pending" },
        { id: 2, condition: "A-then-B-no-C", bornTick: 2, deadline: 5, remainingTicks: 3, seenRequired: {}, status: "pending" },
      ],
    },
    {
      tick: 3,
      outcomes: [],
      instances: [
        { id: 1, condition: "A-then-B-no-C", bornTick: 1, deadline: 4, remainingTicks: 1, seenRequired: { B: 2 }, status: "pending" },
        { id: 2, condition: "A-then-B-no-C", bornTick: 2, deadline: 5, remainingTicks: 2, seenRequired: {}, status: "pending" },
      ],
    },
    {
      tick: 4,
      outcomes: [
        // C at tick 4 falls inside both windows ((1,4] and (2,5]), so both
        // instances violate during the input phase, in instance-id order,
        // before any timeout resolution would run.
        { kind: "violation", reason: "forbidden-event", instanceId: 1, condition: "A-then-B-no-C", tick: 4, event: "C", window: [1, 4] },
        { kind: "violation", reason: "forbidden-event", instanceId: 2, condition: "A-then-B-no-C", tick: 4, event: "C", window: [2, 5] },
      ],
      instances: [],
    },
    { tick: 5, outcomes: [], instances: [] },
  ]);
});

test("snapshot/resume: a restored monitor continues identically to the original", () => {
  const script: string[][] = [
    ["A"], // tick 1
    ["A"], // tick 2
    ["B"], // tick 3
    [], // tick 4
    ["A"], // tick 5
    ["B"], // tick 6
    [], // tick 7
    [], // tick 8
  ];

  // Reference run: uninterrupted.
  const reference = monitorFor(SPEC);
  const refTrace: { outcomes: Outcome[]; instances: unknown[] }[] = [];
  for (const events of script) {
    const outcomes = reference.step(events);
    refTrace.push({ outcomes, instances: summarize(reference.enumerate()) });
  }

  // Resumed run: execute 3 ticks, snapshot, serialize through JSON, restore,
  // then run the remaining ticks.
  const partial = monitorFor(SPEC);
  const resumedTrace: { outcomes: Outcome[]; instances: unknown[] }[] = [];
  for (const events of script.slice(0, 3)) {
    const outcomes = partial.step(events);
    resumedTrace.push({ outcomes, instances: summarize(partial.enumerate()) });
  }
  const restored = Monitor.deserialize(partial.serialize());
  // Snapshot must be plain JSON data.
  equal(typeof partial.serialize(), "string");
  deepEqual(restored.enumerate(), partial.enumerate());
  equal(restored.tick, partial.tick);
  for (const events of script.slice(3)) {
    const outcomes = restored.step(events);
    resumedTrace.push({ outcomes, instances: summarize(restored.enumerate()) });
  }

  deepEqual(resumedTrace, refTrace);
  deepEqual(restored.outcomes, reference.outcomes);
  // Instance ids continue without collision after resume.
  const extra = restored.step(["A"]);
  deepEqual(extra, []);
  ok(restored.enumerate().some((v) => v.id === 4));
});

test("snapshot taken after cancel resumes without the cancelled instance", () => {
  const mon = monitorFor(SPEC);
  mon.step(["A"]); // instance 1
  mon.step(["A"]); // instance 2
  mon.cancel(2);
  const restored = Monitor.fromSnapshot(mon.snapshot());
  deepEqual(
    restored.enumerate().map((v) => v.id),
    [1],
  );
  const outcomes = restored.advance(3);
  equal(outcomes.length, 1);
  equal(outcomes[0]!.instanceId, 1);
});

test("multiple conditions share one monitor and one event stream", () => {
  const mon = monitorFor([
    { name: "ab", trigger: "A", windowTicks: 2, require: ["B"] },
    { name: "xy", trigger: "X", windowTicks: 1, forbid: ["Y"] },
  ]);
  mon.step(["A", "X"]); // tick 1: two instances (ids 1 and 2)
  equal(mon.enumerate().length, 2);
  const t2 = mon.step(["Y"]); // tick 2: Y violates "xy" instance immediately
  equal(t2.length, 1);
  equal(t2[0]!.condition, "xy");
  equal(t2[0]!.kind, "violation");
  const t3 = mon.step([]); // tick 3: "ab" instance times out, B never came
  equal(t3.length, 1);
  equal(t3[0]!.condition, "ab");
  equal(t3[0]!.kind, "violation");
});

test("monitor rejects invalid advance counts and bad snapshots", () => {
  const mon = monitorFor(SPEC);
  throws(() => mon.advance(-1), /non-negative/);
  throws(() => Monitor.deserialize("not json"));
  throws(() => Monitor.fromSnapshot({ version: 2 } as never), /version/);
});

test("compiled conditions can be reused across monitors", () => {
  const cond = compileCondition(SPEC);
  const a = new Monitor(cond);
  const b = new Monitor([cond]);
  a.step(["A"]);
  b.step(["A"]);
  equal(a.enumerate()[0]!.id, 1);
  equal(b.enumerate()[0]!.id, 1);
});
