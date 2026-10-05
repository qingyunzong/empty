import { test } from "node:test";
import { deepEqual, equal, match, ok, rejects } from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ReplayMismatchError,
  Runtime,
  type Snapshot,
  type TraceEvent,
} from "../src/index.js";
import { mutatedProgram, standardProgram } from "./program.js";

const SEED = 42;

async function runProgram(
  program: (rt: Runtime) => void,
  opts: { seed?: number; replay?: TraceEvent[] } = {},
): Promise<{ rt: Runtime; trace: TraceEvent[] }> {
  const rt = new Runtime({ seed: opts.seed ?? SEED, replay: opts.replay });
  program(rt);
  const trace = await rt.run();
  return { rt, trace };
}

function kinds(trace: TraceEvent[]): string {
  return trace.map((e) => `${e.kind}:${e.task}`).join("\n");
}

test("deterministic: same seed yields byte-identical traces", async () => {
  const a = await runProgram(standardProgram);
  const b = await runProgram(standardProgram);
  deepEqual(a.trace, b.trace);
  ok(a.trace.length > 20, "trace should contain a meaningful number of events");
});

test("seed selects the schedule: different seeds interleave differently", async () => {
  const signatures = new Set<string>();
  for (let seed = 1; seed <= 8; seed++) {
    const { trace } = await runProgram(standardProgram, { seed });
    signatures.add(kinds(trace));
  }
  ok(signatures.size > 1, "expected at least two distinct schedules across seeds");
});

test("completion, cancellation and timeout order is recorded", async () => {
  const { trace } = await runProgram(standardProgram);
  const at = (kind: string, task: string) =>
    trace.findIndex((e) => e.kind === kind && e.task === task);

  const cancelAt = at("cancel", "victim");
  const victimDoneAt = at("complete", "victim");
  const timeoutAt = at("timeout", "impatient");
  const impatientDoneAt = at("complete", "impatient");

  ok(cancelAt >= 0, "cancel event recorded");
  ok(timeoutAt >= 0, "timeout event recorded");
  ok(cancelAt < victimDoneAt, "cancel delivered before victim completes");
  ok(timeoutAt < impatientDoneAt, "timeout delivered before impatient completes");
  ok(at("complete", "producer") > at("complete", "tail"), "join keeps producer after tail");

  equal(trace[cancelAt].clock, 5, "killer cancels at virtual time 5");
  equal(trace[timeoutAt].clock, 9, "impatient times out at virtual time 9");
});

test("replay accepts a matching trace and reproduces it exactly", async () => {
  const { trace } = await runProgram(standardProgram);
  const replayed = await runProgram(standardProgram, { replay: trace });
  deepEqual(replayed.trace, trace);
});

test("replay rejects when the program registers a different event set", async () => {
  const { trace } = await runProgram(standardProgram);
  await rejects(runProgram(mutatedProgram, { replay: trace }));
  try {
    await runProgram(mutatedProgram, { replay: trace });
    throw new Error("unreachable");
  } catch (err) {
    ok(err instanceof ReplayMismatchError);
    match((err as Error).message, /event set mismatch/);
  }
});

test("replay rejects a tampered candidate set", async () => {
  const { trace } = await runProgram(standardProgram);
  const tampered: TraceEvent[] = trace.map((e) => ({ ...e, candidates: [...e.candidates] }));
  const choice = tampered.find((e) => e.candidates.length > 1);
  ok(choice, "trace has a multi-candidate choice step");
  (choice as TraceEvent).candidates.push("T999:ghost");
  try {
    await runProgram(standardProgram, { replay: tampered });
    throw new Error("unreachable");
  } catch (err) {
    ok(err instanceof ReplayMismatchError);
    match((err as Error).message, /event set mismatch/);
  }
});

test("replay rejects a truncated trace", async () => {
  const { trace } = await runProgram(standardProgram);
  const truncated = trace.slice(0, trace.length - 1);
  try {
    await runProgram(standardProgram, { replay: truncated });
    throw new Error("unreachable");
  } catch (err) {
    ok(err instanceof ReplayMismatchError);
  }
});

test("segmented snapshots carry RNG state and match the full run step by step", async () => {
  const full = await runProgram(standardProgram);
  const totalSteps = full.rt.snapshots.length;
  ok(totalSteps > 10, "enough steps to segment");

  const boundaries = [3, Math.floor(totalSteps / 2), totalSteps - 2];
  const segmented = new Runtime({ seed: SEED });
  standardProgram(segmented);

  const seen: Snapshot[] = [];
  for (const boundary of boundaries) {
    while (segmented.snapshots.length < boundary) {
      ok(await segmented.step(), "steps remain before boundary");
    }
    const snap = segmented.snapshot();
    equal(typeof snap.rngState, "number", "snapshot carries RNG state");
    // Serialize + restore: the snapshot alone must carry the random state.
    segmented.restore(JSON.parse(JSON.stringify(snap)) as Snapshot);
    seen.push(segmented.snapshot());
  }
  const trace = await segmented.run();

  deepEqual(trace, full.trace, "segmented run reproduces the full-run trace");
  for (let i = 0; i < boundaries.length; i++) {
    deepEqual(
      seen[i],
      full.rt.snapshots[boundaries[i] - 1],
      `snapshot at boundary ${boundaries[i]} matches full run`,
    );
  }
  deepEqual(segmented.snapshot(), full.rt.snapshots[totalSteps - 1]);
});

test("restore rejects a snapshot from a diverged trace", async () => {
  const a = new Runtime({ seed: SEED });
  standardProgram(a);
  const b = new Runtime({ seed: 7 });
  standardProgram(b);
  await a.step();
  await b.step();
  const foreign = b.snapshot();
  let threw = false;
  try {
    a.restore(foreign);
  } catch {
    threw = true;
  }
  ok(threw, "restore must reject a foreign snapshot");
});

test("golden trace for seed 42 is stable", async () => {
  const { trace } = await runProgram(standardProgram);
  const golden = JSON.parse(readFileSync("test/golden/seed-42.json", "utf8")) as TraceEvent[];
  deepEqual(trace, golden);
});
