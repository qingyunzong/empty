"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Engine } = require("../src/engine");
const { LabError, CODES } = require("../src/errors");

const CFG = { channels: 1, initialTemp: 20, cooldown: 5 };

function enqueue(id, extra = {}) {
  return {
    op: "enqueue",
    task: {
      id,
      project: "P1",
      volume: 10,
      priority: 1,
      segments: [{ temp: 20, duration: 5 }],
      ...extra,
    },
  };
}

test("basic parallel scheduling on two channels", () => {
  const e = new Engine({ channels: 2, initialTemp: 20 });
  for (const id of ["t1", "t2", "t3", "t4"]) {
    e.applyOp(enqueue(id, { segments: [{ temp: 20, duration: 4 }] }));
  }
  e.finish();
  const out = e.getOutput();
  assert.equal(out.makespan, 8);
  assert.equal(out.channels[0].blocks.length, 2);
  assert.equal(out.channels[1].blocks.length, 2);
});

test("temperature switch inserts cooldown between segments", () => {
  const e = new Engine(CFG);
  e.applyOp(enqueue("t1", { segments: [{ temp: 20, duration: 10 }, { temp: 37, duration: 10 }] }));
  e.finish();
  const blocks = e.getOutput().channels[0].blocks;
  assert.deepEqual(
    blocks.map((b) => [b.type, b.start, b.end]),
    [
      ["run", 0, 10],
      ["cooldown", 10, 15],
      ["run", 15, 25],
    ]
  );
  assert.equal(e.getOutput().makespan, 25);
});

test("acceptance 2: high priority preempts at segment boundary, resume continues", () => {
  const e = new Engine(CFG);
  e.applyOp({
    op: "enqueue",
    time: 0,
    task: {
      id: "low",
      project: "P1",
      volume: 10,
      priority: 1,
      segments: [
        { temp: 20, duration: 10 },
        { temp: 20, duration: 10 },
      ],
    },
  });
  e.applyOp({
    op: "enqueue",
    time: 3,
    task: { id: "high", project: "P1", volume: 10, priority: 5, segments: [{ temp: 20, duration: 3 }] },
  });
  e.finish();
  const out = e.getOutput();
  const blocks = out.channels[0].blocks;
  // Low task finishes its current segment [0,10], is preempted at the
  // boundary, high runs [10,13], low resumes segment 1 at [13,23].
  assert.deepEqual(
    blocks.map((b) => [b.taskId, b.segment, b.start, b.end]),
    [
      ["low", 0, 0, 10],
      ["high", 0, 10, 13],
      ["low", 1, 13, 23],
    ]
  );
  const preempt = out.events.find((ev) => ev.type === "preempt");
  assert.equal(preempt.taskId, "low");
  assert.equal(preempt.time, 10);
  assert.equal(preempt.atSegment, 1); // partial progress saved
  const resume = out.events.find((ev) => ev.type === "resume");
  assert.equal(resume.taskId, "low");
  assert.equal(resume.segment, 1); // resumes from the interruption point
  assert.equal(out.makespan, 23);
});

test("acceptance 3: budget correction into deficit blocks new starts, queue order deterministic", () => {
  const build = () => {
    const e = new Engine(CFG);
    e.applyOp({ op: "budget", project: "P1", set: 100 });
    for (const id of ["A", "B", "C"]) {
      e.applyOp(enqueue(id, { volume: 30, segments: [{ temp: 20, duration: 5 }] }));
    }
    e.applyOp({ op: "budget", project: "P1", set: 20, time: 1 }); // sufficient -> deficit
    e.finish();
    return e.getOutput();
  };
  const out1 = build();
  const out2 = build();
  // A started (charged 30) before the cut; B and C can never start (20 < 30).
  assert.deepEqual(out1.waiting, ["B", "C"]);
  assert.equal(out1.budgets.P1, 20);
  assert.equal(out1.makespan, 5);
  assert.equal(out1.events.filter((ev) => ev.type === "charge").length, 1);
  // Deterministic: identical op stream yields identical log root.
  assert.equal(out1.logRoot, out2.logRoot);
});

test("abort of a waiting task removes it without contamination", () => {
  const e = new Engine(CFG);
  e.applyOp(enqueue("t1", { segments: [{ temp: 20, duration: 10 }] }));
  e.applyOp(enqueue("t2"));
  e.applyOp({ op: "abort", taskId: "t2" });
  e.finish();
  const out = e.getOutput();
  assert.deepEqual(out.waiting, []);
  assert.equal(out.contaminatedWells, 0);
  assert.equal(out.events.filter((ev) => ev.type === "abort").length, 1);
  assert.deepEqual(out.failures, []);
});

test("undo rolls back in stack order; empty stack is a failure, not fatal", () => {
  const e = new Engine(CFG);
  e.applyOp(enqueue("t1", { segments: [{ temp: 20, duration: 10 }] }));
  e.applyOp(enqueue("t2"));
  e.applyOp({ op: "undo" }); // removes enqueue t2
  e.applyOp({ op: "undo" }); // removes enqueue t1
  e.applyOp({ op: "undo" }); // nothing left
  e.finish();
  const out = e.getOutput();
  assert.equal(out.makespan, 0);
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].code, "NOTHING_TO_UNDO");
});

test("undo of an abort does not resurrect confirmed contaminated wells", () => {
  const e = new Engine(CFG);
  e.applyOp(
    enqueue("t1", {
      volume: 30, // 3 wells
      segments: [
        { temp: 20, duration: 10 },
        { temp: 20, duration: 10 },
      ],
    })
  );
  e.applyOp({ op: "abort", taskId: "t1", time: 3 });
  // Let time pass so the abort finalizes at the boundary (t=10) and the
  // contamination is confirmed before the undo arrives.
  e.applyOp({ op: "undo", time: 20 });
  e.finish();
  const out = e.getOutput();
  // Undo restored the task (it now runs to completion)...
  assert.equal(out.events.some((ev) => ev.type === "complete" && ev.taskId === "t1"), true);
  // ...but the 3 wells confirmed contaminated stay contaminated.
  assert.equal(out.contaminatedWells, 3);
});

test("correct changes volume, recomputes charge and feasibility", () => {
  const e = new Engine(CFG);
  e.applyOp({ op: "budget", project: "P1", set: 100 });
  e.applyOp(enqueue("t1", { volume: 30 }));
  e.applyOp({ op: "correct", taskId: "t1", volume: 50 });
  e.finish();
  assert.equal(e.getOutput().budgets.P1, 50); // 100 - 50
  assert.throws(
    () => {
      const e2 = new Engine(CFG);
      e2.applyOp({ op: "budget", project: "P1", set: 40 });
      e2.applyOp(enqueue("t1", { volume: 30 })); // charged 30, budget 10
      e2.applyOp({ op: "correct", taskId: "t1", volume: 50 }); // needs +20 -> -10
    },
    (err) => err instanceof LabError && err.code === CODES.BUDGET_NEGATIVE
  );
  const e3 = new Engine(CFG);
  e3.applyOp({ op: "correct", taskId: "ghost", volume: 10 });
  assert.equal(e3.getOutput().failures[0].code, "UNKNOWN_TASK");
});

test("fatal data errors carry the required codes", () => {
  assert.throws(
    () => new Engine(CFG).applyOp(enqueue("big", { volume: 5000 })),
    (err) => err.code === CODES.VOLUME_EXCEEDS_PLATE
  );
  assert.throws(
    () => new Engine(CFG).applyOp({ op: "budget", project: "P1", set: -1 }),
    (err) => err.code === CODES.BUDGET_NEGATIVE
  );
  assert.throws(
    () =>
      new Engine(CFG).applyOp(
        enqueue("hot", {
          segments: [
            { temp: 20, duration: 5 },
            { temp: 100, duration: 5 },
          ],
        })
      ),
    (err) => err.code === CODES.COOLDOWN_CONFLICT
  );
});

test("fairness: round-robin across projects with wait aging, id tie-break", () => {
  const e = new Engine({ channels: 1, initialTemp: 20 });
  // Two projects, same priority, same arrival time, one channel.
  e.applyOp(enqueue("a1", { project: "Alpha", segments: [{ temp: 20, duration: 2 }] }));
  e.applyOp(enqueue("b1", { project: "Beta", segments: [{ temp: 20, duration: 2 }] }));
  e.applyOp(enqueue("a2", { project: "Alpha", segments: [{ temp: 20, duration: 2 }] }));
  e.applyOp(enqueue("b2", { project: "Beta", segments: [{ temp: 20, duration: 2 }] }));
  e.finish();
  const starts = e
    .getOutput()
    .events.filter((ev) => ev.type === "start")
    .map((ev) => ev.taskId);
  // Round-robin alternates projects: Alpha, Beta, Alpha, Beta.
  assert.deepEqual(starts, ["a1", "b1", "a2", "b2"]);
});
