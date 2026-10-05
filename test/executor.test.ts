import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGraph,
  CycleError,
  execute,
  GraphValidationError,
  type TaskContext,
  type TaskDefinition,
} from "../src/index.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const task = (
  id: string,
  deps: readonly string[] = [],
  run: (ctx: TaskContext) => unknown = () => id,
): TaskDefinition => ({ id, deps, run });

test("diamond graph: node runs only after all dependencies succeed", async () => {
  const events: string[] = [];
  const track =
    (id: string, ms = 0) =>
    async () => {
      events.push(`start:${id}`);
      if (ms > 0) await delay(ms);
      events.push(`end:${id}`);
      return id;
    };
  const report = await execute([
    task("a", [], track("a")),
    task("b", ["a"], track("b", 20)),
    task("c", ["a"], track("c", 5)),
    task("d", ["b", "c"], track("d")),
  ]);

  for (const id of ["a", "b", "c", "d"]) {
    assert.equal(report.results.get(id)!.status, "succeeded");
  }
  // d starts only after BOTH b and c finished, even though c finished earlier.
  assert.ok(events.indexOf("start:d") > events.indexOf("end:b"));
  assert.ok(events.indexOf("start:d") > events.indexOf("end:c"));
  assert.equal(report.results.get("d")!.value, "d");
});

test("failure cancels only its successors; unrelated branches continue", async () => {
  const report = await execute([
    task("bad", [], () => {
      throw new Error("boom");
    }),
    task("child", ["bad"]),
    task("grandchild", ["child"]),
    task("slow-ok", [], async () => {
      await delay(30);
      return "fine";
    }),
    task("slow-ok-child", ["slow-ok"]),
  ]);

  assert.equal(report.results.get("bad")!.status, "failed");
  assert.equal(report.results.get("child")!.status, "cancelled");
  assert.equal(report.results.get("grandchild")!.status, "cancelled");
  assert.equal(report.results.get("slow-ok")!.status, "succeeded");
  assert.equal(report.results.get("slow-ok-child")!.status, "succeeded");
  assert.deepEqual(report.startOrder, ["bad", "slow-ok", "slow-ok-child"]);
});

test("async rejection is treated as failure and propagates cancellation", async () => {
  const report = await execute([
    task("root", [], async () => {
      await delay(5);
      throw new Error("async boom");
    }),
    task("down", ["root"]),
    task("down2", ["down"]),
  ]);
  assert.equal(report.results.get("root")!.status, "failed");
  assert.ok(report.results.get("root")!.error instanceof Error);
  assert.equal(report.results.get("down")!.status, "cancelled");
  assert.equal(report.results.get("down2")!.status, "cancelled");
});

test("node with one failed and one succeeded dependency is cancelled", async () => {
  const report = await execute([
    task("ok", [], () => "ok"),
    task("bad", [], () => {
      throw new Error("boom");
    }),
    task("join", ["ok", "bad"]),
    task("after-join", ["join"]),
  ]);
  assert.equal(report.results.get("ok")!.status, "succeeded");
  assert.equal(report.results.get("bad")!.status, "failed");
  assert.equal(report.results.get("join")!.status, "cancelled");
  assert.equal(report.results.get("after-join")!.status, "cancelled");
});

test("cancellation reaching a succeeded node does not roll it back", async () => {
  // "shared" succeeds before "bad" fails; the cancellation wave triggered by
  // "bad" must leave "shared" (and its already-finished branch) untouched.
  const report = await execute([
    task("shared", [], async () => {
      await delay(10);
      return "shared-value";
    }),
    task("bad", ["shared"], async () => {
      await delay(10);
      throw new Error("late boom");
    }),
    task("victim", ["bad"]),
    task("also-uses-shared", ["shared"], async (ctx) => {
      await delay(40);
      return ctx.id;
    }),
  ]);
  assert.equal(report.results.get("shared")!.status, "succeeded");
  assert.equal(report.results.get("shared")!.value, "shared-value");
  assert.equal(report.results.get("bad")!.status, "failed");
  assert.equal(report.results.get("victim")!.status, "cancelled");
  assert.equal(report.results.get("also-uses-shared")!.status, "succeeded");
});

test("dependency outputs are available to dependents via ctx.outputOf", async () => {
  const report = await execute([
    { id: "a", run: () => 2 },
    { id: "b", deps: ["a"], run: (ctx) => (ctx.outputOf("a") as number) * 3 },
    {
      id: "c",
      deps: ["a", "b"],
      run: (ctx) => (ctx.outputOf("a") as number) + (ctx.outputOf("b") as number),
    },
  ]);
  assert.equal(report.results.get("c")!.value, 8);
});

test("cycle is rejected with the cycle path", () => {
  const defs = [
    task("entry"),
    task("a", ["c"]),
    task("b", ["a"]),
    task("c", ["b"]),
  ];
  assert.throws(
    () => buildGraph(defs),
    (err: unknown) => {
      assert.ok(err instanceof CycleError);
      // Path follows dependency edges: a depends on c, c on b, b on a.
      assert.deepEqual(err.cycle, ["a", "c", "b", "a"]);
      assert.equal(err.message, "Dependency cycle detected: a -> c -> b -> a");
      return true;
    },
  );
});

test("self-dependency is rejected as a cycle", () => {
  assert.throws(
    () => buildGraph([task("a", ["a"])]),
    (err: unknown) => {
      assert.ok(err instanceof CycleError);
      assert.deepEqual(err.cycle, ["a", "a"]);
      return true;
    },
  );
});

test("unknown dependency and duplicate id are rejected", () => {
  assert.throws(() => buildGraph([task("a", ["ghost"])]), GraphValidationError);
  assert.throws(
    () => buildGraph([task("a"), task("a")]),
    GraphValidationError,
  );
});

test("deterministic executor: every node starts exactly once, stable order", async () => {
  const defs: TaskDefinition[] = [
    task("a"),
    task("b"),
    task("c", ["a"]),
    task("d", ["a", "b"]),
    task("e", ["c", "d"]),
    task("f"),
  ];
  const first = await execute(defs);
  const second = await execute(defs);

  assert.deepEqual(first.startOrder, ["a", "b", "f", "c", "d", "e"]);
  assert.deepEqual(second.startOrder, first.startOrder);
  assert.equal(new Set(first.startOrder).size, first.startOrder.length);
  assert.equal(first.startOrder.length, defs.length);
});

test("cancelled nodes never start; started nodes start exactly once", async () => {
  let runs = 0;
  const counted = (id: string, deps: string[] = [], fail = false): TaskDefinition => ({
    id,
    deps,
    run: () => {
      runs += 1;
      if (fail) throw new Error(`${id} failed`);
      return id;
    },
  });
  const report = await execute([
    counted("a", [], true),
    counted("b", ["a"]),
    counted("c", ["b"]),
    counted("d"),
    counted("e", ["d"]),
  ]);
  assert.equal(runs, 3); // a, d, e — cancelled b and c never ran
  assert.equal(new Set(report.startOrder).size, report.startOrder.length);
  assert.deepEqual(report.startOrder, ["a", "d", "e"]);
});

test("empty graph resolves immediately", async () => {
  const report = await execute([]);
  assert.deepEqual(report.startOrder, []);
  assert.equal(report.results.size, 0);
});
