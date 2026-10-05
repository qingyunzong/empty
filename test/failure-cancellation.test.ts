import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ControllableExecutor,
  type TestCaseDef,
} from "../src/index.js";

// P passes; its child A fails while sibling B still runs. C and D hang off A.
// J joins A and B: cancelled because of A even though B passed.
const defs: TestCaseDef[] = [
  { id: "P" },
  { id: "A", dependsOn: ["P"] },
  { id: "B", dependsOn: ["P"] },
  { id: "C", dependsOn: ["A"] },
  { id: "D", dependsOn: ["C"] },
  { id: "E", dependsOn: ["B"] },
  { id: "J", dependsOn: ["A", "B"] },
];

function makeExecutor(executed: string[]): ControllableExecutor {
  return new ControllableExecutor(defs, {
    run: (id) => {
      executed.push(id);
      if (id === "A") throw new Error("A blew up");
    },
  });
}

test("failure cancels transitive successors but never siblings", async () => {
  const executed: string[] = [];
  const executor = makeExecutor(executed);
  await executor.runAll();

  assert.deepEqual(executed.sort(), ["A", "B", "E", "P"]);
  assert.deepEqual(executor.results(), [
    { id: "A", status: "failed", error: "A blew up" },
    { id: "B", status: "passed" },
    { id: "C", status: "cancelled" },
    { id: "D", status: "cancelled" },
    { id: "E", status: "passed" },
    { id: "J", status: "cancelled" },
    { id: "P", status: "passed" },
  ]);
});

test("controllable stepping exposes the ready set between steps", async () => {
  const executed: string[] = [];
  const executor = makeExecutor(executed);

  assert.deepEqual(executor.readySet(), ["P"]);
  assert.equal(await executor.step(), "P");
  assert.deepEqual(executor.readySet(), ["A", "B"]);

  assert.equal(await executor.step(), "A"); // fails here
  // B (sibling) remains ready; C, D, J are cancelled.
  assert.deepEqual(executor.readySet(), ["B"]);

  assert.equal(await executor.step(), "B");
  assert.deepEqual(executor.readySet(), ["E"]);
  assert.equal(await executor.step(), "E");
  assert.equal(await executor.step(), null);
  assert.ok(executor.isSettled());
});

test("failure of a join prerequisite cancels the join even if others pass", async () => {
  const executed: string[] = [];
  const executor = new ControllableExecutor(
    [
      { id: "left" },
      { id: "right" },
      { id: "join", dependsOn: ["left", "right"] },
    ],
    {
      run: (id) => {
        executed.push(id);
        if (id === "left") throw new Error("left failed");
      },
    },
  );
  await executor.runAll();
  assert.deepEqual(executed.sort(), ["left", "right"]);
  assert.deepEqual(executor.results(), [
    { id: "join", status: "cancelled" },
    { id: "left", status: "failed", error: "left failed" },
    { id: "right", status: "passed" },
  ]);
});
