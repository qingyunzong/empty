import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  CycleError,
  DuplicateTaskError,
  Executor,
  UnknownDependencyError,
  type ExecutableTask,
  type TaskStatus,
} from "../src/index.js";

const ok = () => () => {};
const fail = (msg: string) => () => {
  throw new Error(msg);
};

function statusesOf(result: { statuses: ReadonlyMap<string, TaskStatus> }) {
  return Object.fromEntries(result.statuses);
}

test("diamond graph: deps run before dependents, each node starts exactly once", async () => {
  const starts = new Map<string, number>();
  const track = (id: string) => () => {
    starts.set(id, (starts.get(id) ?? 0) + 1);
  };
  const tasks: ExecutableTask[] = [
    { id: "a", run: track("a") },
    { id: "b", deps: ["a"], run: track("b") },
    { id: "c", deps: ["a"], run: track("c") },
    { id: "d", deps: ["b", "c"], run: track("d") },
  ];
  const result = await new Executor(tasks).run();
  assert.deepEqual(statusesOf(result), {
    a: "succeeded",
    b: "succeeded",
    c: "succeeded",
    d: "succeeded",
  });
  for (const id of ["a", "b", "c", "d"]) assert.equal(starts.get(id), 1, `${id} started once`);
  assert.deepEqual(result.started, ["a", "b", "c", "d"]); // deterministic sorted order
  assert.equal(new Set(result.started).size, result.started.length, "no duplicate starts");
});

test("failure cancels only its successors; unrelated branches keep running", async () => {
  // x fails -> y, z cancelled; independent branch p -> q still runs.
  const tasks: ExecutableTask[] = [
    { id: "x", run: fail("boom") },
    { id: "y", deps: ["x"], run: ok() },
    { id: "z", deps: ["y"], run: ok() },
    { id: "p", run: ok() },
    { id: "q", deps: ["p"], run: ok() },
  ];
  const result = await new Executor(tasks).run();
  assert.deepEqual(statusesOf(result), {
    x: "failed",
    y: "cancelled",
    z: "cancelled",
    p: "succeeded",
    q: "succeeded",
  });
  assert.deepEqual(result.started, ["p", "q", "x"]);
  assert.match(String(result.errors.get("x")), /boom/);
});

test("node runs only when ALL dependencies succeeded", async () => {
  // join needs both left and right; left fails -> join cancelled, right still ran.
  const tasks: ExecutableTask[] = [
    { id: "left", run: fail("left broke") },
    { id: "right", run: ok() },
    { id: "join", deps: ["left", "right"], run: ok() },
  ];
  const result = await new Executor(tasks).run();
  assert.deepEqual(statusesOf(result), {
    left: "failed",
    right: "succeeded",
    join: "cancelled",
  });
  assert.deepEqual(result.started, ["left", "right"]);
});

test("async rejection marks failure and cancels downstream only", async () => {
  const tasks: ExecutableTask[] = [
    { id: "fetch", run: async () => Promise.reject(new Error("net down")) },
    { id: "parse", deps: ["fetch"], run: ok() },
    { id: "cache", run: ok() },
  ];
  const result = await new Executor(tasks).run();
  assert.deepEqual(statusesOf(result), {
    fetch: "failed",
    parse: "cancelled",
    cache: "succeeded",
  });
});

test("cancellation reaching a succeeded node does not roll it back", async () => {
  const tasks: ExecutableTask[] = [
    { id: "root", run: ok() },
    { id: "child", deps: ["root"], run: ok() },
  ];
  const executor = new Executor(tasks);
  const result = await executor.run();
  assert.equal(result.statuses.get("root"), "succeeded");
  executor.cancel("root"); // terminal state: must be a no-op
  assert.equal(executor.status("root"), "succeeded");
  assert.equal(executor.status("child"), "succeeded");
});

test("manual cancel of a pending node propagates to pending successors only", async () => {
  const tasks: ExecutableTask[] = [
    { id: "a", run: ok() },
    { id: "b", deps: ["a"], run: ok() },
    { id: "c", deps: ["b"], run: ok() },
  ];
  const executor = new Executor(tasks);
  executor.cancel("b");
  const result = await executor.run();
  assert.deepEqual(statusesOf(result), {
    a: "succeeded",
    b: "cancelled",
    c: "cancelled",
  });
  assert.deepEqual(result.started, ["a"]);
});

test("cycle input is rejected with the cycle path", () => {
  assert.throws(
    () =>
      buildGraph([
        { id: "a", deps: ["c"] },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["b"] },
      ]),
    (err: unknown) => {
      assert.ok(err instanceof CycleError);
      assert.deepEqual(err.cycle, ["a", "c", "b", "a"]);
      assert.match(err.message, /a -> c -> b -> a/);
      return true;
    },
  );
});

test("self-dependency is rejected as a cycle", () => {
  assert.throws(() => buildGraph([{ id: "a", deps: ["a"] }]), (err: unknown) => {
    assert.ok(err instanceof CycleError);
    assert.deepEqual(err.cycle, ["a", "a"]);
    return true;
  });
});

test("unknown dependency and duplicate ids are rejected", () => {
  assert.throws(() => buildGraph([{ id: "a", deps: ["ghost"] }]), UnknownDependencyError);
  assert.throws(
    () => buildGraph([{ id: "a" }, { id: "a" }]),
    DuplicateTaskError,
  );
});

test("larger graph: every node starts at most once, failures prune only their subtree", async () => {
  //      root
  //     /    \
  //   bad    good
  //   / \    /  \
  //  s1  s2 t1  t2
  //      \  /
  //      join   (deps: s2, t1)
  const started: string[] = [];
  const track = (id: string) => () => {
    started.push(id);
  };
  const tasks: ExecutableTask[] = [
    { id: "root", run: track("root") },
    { id: "bad", deps: ["root"], run: () => { started.push("bad"); throw new Error("bad"); } },
    { id: "good", deps: ["root"], run: track("good") },
    { id: "s1", deps: ["bad"], run: track("s1") },
    { id: "s2", deps: ["bad"], run: track("s2") },
    { id: "t1", deps: ["good"], run: track("t1") },
    { id: "t2", deps: ["good"], run: track("t2") },
    { id: "join", deps: ["s2", "t1"], run: track("join") },
  ];
  const result = await new Executor(tasks).run();
  assert.deepEqual(statusesOf(result), {
    root: "succeeded",
    bad: "failed",
    good: "succeeded",
    s1: "cancelled",
    s2: "cancelled",
    t1: "succeeded",
    t2: "succeeded",
    join: "cancelled",
  });
  assert.deepEqual(started, ["root", "bad", "good", "t1", "t2"]);
  assert.equal(new Set(started).size, started.length, "each node started at most once");
  assert.deepEqual([...result.started], started);
});
