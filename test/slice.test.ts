import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, replay, TraceEvent } from "../src/trace";
import { dynamicSlice } from "../src/slice";
import { checkSlice, isControlClosed, projectMask } from "../src/verify";
import { genTrace } from "../src/gen";

const sorted = (s: Set<number>): number[] => [...s].sort((a, b) => a - b);

test("overwrite: stale writes to the same variable are dropped", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "x", value: 1 }, // 0 dead: overwritten by #2
    { op: "const", out: "y", value: 9 }, // 1 irrelevant
    { op: "const", out: "x", value: 2 }, // 2
    { op: "output", arg: "x" }, //          3
  ];
  const slice = dynamicSlice(trace, 3);
  assert.deepEqual(sorted(slice), [2, 3]);
  const check = checkSlice(trace, 3, slice);
  assert.ok(check.reproduces && check.minimal);
});

test("data chain: transitive reads are kept, noise is excluded", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "x", value: 2 }, // 0
    { op: "const", out: "y", value: 3 }, // 1
    { op: "compute", out: "z", fn: "add", args: ["x", "y"] }, // 2
    { op: "const", out: "w", value: 8 }, // 3 noise
    { op: "compute", out: "w", fn: "mul", args: ["w", "w"] }, // 4 noise
    { op: "output", arg: "z" }, // 5
  ];
  const slice = dynamicSlice(trace, 5);
  assert.deepEqual(sorted(slice), [0, 1, 2, 5]);
  const check = checkSlice(trace, 5, slice);
  assert.ok(check.reproduces && check.minimal);
  assert.equal(check.originalValue, 5);
});

test("self-referential write keeps the earlier definition", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "x", value: 1 }, // 0
    { op: "compute", out: "x", fn: "add", args: ["x", "x"] }, // 1 x = 2
    { op: "output", arg: "x" }, // 2
  ];
  const slice = dynamicSlice(trace, 2);
  assert.deepEqual(sorted(slice), [0, 1, 2]);
  const check = checkSlice(trace, 2, slice);
  assert.ok(check.reproduces && check.minimal);
  assert.equal(check.originalValue, 2);
});

test("control dependence: the governing if and its condition are preserved", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "c", value: 1 }, // 0
    { op: "const", out: "x", value: 0 }, // 1 dead on the taken path
    { op: "if", cond: "c" }, //            2
    { op: "const", out: "x", value: 5 }, // 3
    { op: "end" }, //                      4
    { op: "output", arg: "x" }, //         5
  ];
  const slice = dynamicSlice(trace, 5);
  assert.deepEqual(sorted(slice), [0, 2, 3, 5]);
  const check = checkSlice(trace, 5, slice);
  assert.ok(check.reproduces && check.minimal);
  assert.equal(check.slicedValue, 5);
});

test("control dependence: untaken branch writes are excluded, else branch kept", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "c", value: 0 }, // 0
    { op: "const", out: "x", value: 1 }, // 1 dead: else overwrites
    { op: "if", cond: "c" }, //            2
    { op: "const", out: "x", value: 2 }, // 3 not executed
    { op: "else" }, //                     4
    { op: "const", out: "x", value: 3 }, // 5 executed
    { op: "end" }, //                      6
    { op: "output", arg: "x" }, //         7
  ];
  const slice = dynamicSlice(trace, 7);
  assert.deepEqual(sorted(slice), [0, 2, 5, 7]);
  const check = checkSlice(trace, 7, slice);
  assert.ok(check.reproduces && check.minimal);
  assert.equal(check.slicedValue, 3);
});

test("nested control dependence is transitive", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "a", value: 1 }, // 0
    { op: "const", out: "b", value: 1 }, // 1
    { op: "const", out: "x", value: 0 }, // 2 dead on the taken path
    { op: "if", cond: "a" }, //            3
    { op: "if", cond: "b" }, //            4
    { op: "const", out: "x", value: 7 }, // 5
    { op: "end" }, //                      6
    { op: "end" }, //                      7
    { op: "output", arg: "x" }, //         8
  ];
  const slice = dynamicSlice(trace, 8);
  assert.deepEqual(sorted(slice), [0, 1, 3, 4, 5, 8]);
  const check = checkSlice(trace, 8, slice);
  assert.ok(check.reproduces && check.minimal);
});

test("output inside a branch pulls in its controller", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "c", value: 1 }, // 0
    { op: "if", cond: "c" }, //            1
    { op: "const", out: "x", value: 4 }, // 2
    { op: "output", arg: "x" }, //         3 target, inside the branch
    { op: "end" }, //                      4
  ];
  const slice = dynamicSlice(trace, 3);
  assert.deepEqual(sorted(slice), [0, 1, 2, 3]);
  const check = checkSlice(trace, 3, slice);
  assert.ok(check.reproduces && check.minimal);
});

test("other output events are observations, not part of the slice", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "x", value: 1 }, // 0
    { op: "output", arg: "x" }, //          1 unrelated observation
    { op: "const", out: "x", value: 2 }, // 2
    { op: "output", arg: "x" }, //          3 target
  ];
  const slice = dynamicSlice(trace, 3);
  assert.deepEqual(sorted(slice), [2, 3]);
  const check = checkSlice(trace, 3, slice);
  assert.ok(check.reproduces && check.minimal);
  assert.equal(check.slicedValue, 2);
});

test("deleting non-slice events replays to the same output", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "n", value: 40 }, // 0 noise
    { op: "const", out: "a", value: 6 }, // 1
    { op: "const", out: "b", value: 7 }, // 2
    { op: "compute", out: "n", fn: "sub", args: ["n", "a"] }, // 3 noise
    { op: "compute", out: "p", fn: "mul", args: ["a", "b"] }, // 4
    { op: "output", arg: "n" }, // 5 noise observation
    { op: "output", arg: "p" }, // 6 target
  ];
  const slice = dynamicSlice(trace, 6);
  assert.deepEqual(sorted(slice), [1, 2, 4, 6]);
  const structure = analyze(trace);
  const kept = projectMask(trace, structure, slice);
  assert.equal(kept.size, 4);
  assert.equal(replay(trace, kept).outputs.get(6), replay(trace).outputs.get(6));
});

test("verifier detects a non-minimal candidate set", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "x", value: 1 }, // 0 redundant extra
    { op: "const", out: "y", value: 2 }, // 1
    { op: "output", arg: "y" }, //          2
  ];
  const bloated = new Set([0, 1, 2]); // true slice is {1, 2}
  const check = checkSlice(trace, 2, bloated);
  assert.ok(check.reproduces);
  assert.equal(check.minimal, false);
  assert.deepEqual(check.counterexample, [1, 2]);
});

test("slice of a non-executed or non-output target throws", () => {
  const trace: TraceEvent[] = [
    { op: "const", out: "c", value: 0 },
    { op: "if", cond: "c" },
    { op: "const", out: "x", value: 1 },
    { op: "output", arg: "x" }, // 3 never executed
    { op: "end" },
    { op: "const", out: "y", value: 2 }, // 5 not an output
  ];
  assert.throws(() => dynamicSlice(trace, 3));
  assert.throws(() => dynamicSlice(trace, 5));
});

test("acceptance: seeded random traces (<=20 events), exhaustive minimality", () => {
  let totalChecked = 0;
  let maxSlice = 0;
  let totalSlice = 0;
  let totalEvents = 0;
  const runs = 500;
  for (let seed = 1; seed <= runs; seed++) {
    const { trace, target } = genTrace(seed, 20);
    assert.ok(trace.length <= 20, `trace too long: ${trace.length}`);
    const slice = dynamicSlice(trace, target);
    const structure = analyze(trace);
    assert.ok(isControlClosed(structure, slice), `seed ${seed}: slice not control-closed`);
    const check = checkSlice(trace, target, slice);
    assert.ok(check.reproduces, `seed ${seed}: slice does not reproduce output`);
    assert.ok(
      check.minimal,
      `seed ${seed}: proper subset ${JSON.stringify(check.counterexample)} also reproduces`,
    );
    totalChecked += check.checked;
    maxSlice = Math.max(maxSlice, slice.size);
    totalSlice += slice.size;
    totalEvents += trace.length;
  }
  console.log(
    `  ${runs} random traces: avg events ${(totalEvents / runs).toFixed(1)},` +
      ` avg slice ${(totalSlice / runs).toFixed(1)}, max slice ${maxSlice},` +
      ` ${totalChecked} control-closed subsets replayed, all minimal`,
  );
});
