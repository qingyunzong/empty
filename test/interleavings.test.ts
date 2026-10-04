import assert from "node:assert/strict";
import { test } from "node:test";
import { EventBus, type Subscription } from "../src/event-bus";
import { interpret } from "../src/interpreter";
import { runScenario } from "../src/runner";
import type { Action, Scenario } from "../src/scenario";

const ticks = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: unknown;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`deadlock suspected: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** All plans of length 0..maxLen over the given action pool. */
function plans(pool: readonly Action[], maxLen: number): Action[][] {
  const result: Action[][] = [[]];
  let frontier: Action[][] = [[]];
  for (let length = 1; length <= maxLen; length++) {
    const next: Action[][] = [];
    for (const prefix of frontier) {
      for (const action of pool) next.push([...prefix, action]);
    }
    result.push(...next);
    frontier = next;
  }
  return result;
}

const A_POOL: readonly Action[] = [
  { do: "publish", topic: "b" },
  { do: "republish", maxDepth: 1 },
  { do: "unsubscribe", name: "A1" },
  { do: "unsubscribe", name: "A2" },
  { do: "unsubscribe", name: "B1" },
  { do: "subscribe", as: "D", topic: "a", plan: [] },
  { do: "subscribe", as: "E", topic: "b", plan: [{ do: "fail", message: "E" }] },
  { do: "fail", message: "x" },
  { do: "yield", ticks: 1 },
];

const B_POOL: readonly Action[] = [
  { do: "unsubscribe", name: "A1" },
  { do: "unsubscribe", name: "B1" },
  { do: "fail", message: "y" },
  { do: "yield", ticks: 1 },
];

test("enumeration: nested publish / cancel / remove interleavings never deadlock and match the interpreter", async () => {
  const a1Plans = plans(A_POOL, 2);
  const a2Plans = plans(A_POOL, 1);
  const b1Plans = plans(B_POOL, 1);
  let checked = 0;
  for (const a1 of a1Plans) {
    for (const a2 of a2Plans) {
      for (const b1 of b1Plans) {
        const scenario: Scenario = {
          subscriptions: [
            { name: "A1", topic: "a", plan: a1 },
            { name: "A2", topic: "a", plan: a2 },
            { name: "B1", topic: "b", plan: b1 },
          ],
          rootTopic: "a",
        };
        const expected = interpret(scenario);
        const label = `A1=${JSON.stringify(a1)} A2=${JSON.stringify(a2)} B1=${JSON.stringify(b1)}`;
        const sync = await withTimeout(runScenario(scenario, "sync"), 1000, label);
        const async = await withTimeout(runScenario(scenario, "async"), 1000, label);
        try {
          assert.deepEqual(sync.trace, [...expected.trace]);
          assert.deepEqual(sync.errors, [...expected.errors]);
          assert.equal(sync.inFlightAfter, 0);
          assert.deepEqual(async.trace, [...expected.trace]);
          assert.deepEqual(async.errors, [...expected.errors]);
          assert.equal(async.inFlightAfter, 0);
        } catch (error) {
          throw new Error(`interleaving mismatch (${label}): ${(error as Error).message}`);
        }
        checked++;
      }
    }
  }
  // 91 * 10 * 5 = 4550 interleavings, each run in sync and async mode.
  assert.equal(checked, 4550);
});

test("enumeration: wait-removal interleavings across nested publishes terminate", async () => {
  type Act = "none" | "waitSelf" | "waitOther" | "removeOther";
  const acts: Act[] = ["none", "waitSelf", "waitOther", "removeOther"];
  let checked = 0;
  for (const actX of acts) {
    for (const actY of acts) {
      const bus = new EventBus();
      const calls: string[] = [];
      let subX!: Subscription;
      let subY!: Subscription;
      const apply = async (self: Subscription, other: Subscription, act: Act): Promise<void> => {
        if (act === "waitSelf") await self.unsubscribe({ wait: true });
        else if (act === "waitOther") await other.unsubscribe({ wait: true });
        else if (act === "removeOther") other.unsubscribe();
      };
      subX = bus.subscribe("a", async () => {
        calls.push("X:start");
        await ticks(1);
        const nested = bus.publish("b", undefined);
        await apply(subX, subY, actX);
        await nested;
        calls.push("X:end");
      });
      subY = bus.subscribe("b", async () => {
        calls.push("Y:start");
        await ticks(1);
        await apply(subY, subX, actY);
        calls.push("Y:end");
      });
      await withTimeout(bus.publish("a", undefined), 1000, `X=${actX} Y=${actY}`);
      assert.deepEqual(calls, ["X:start", "Y:start", "Y:end", "X:end"]);
      assert.equal(bus.inFlightCount, 0);
      checked++;
    }
  }
  assert.equal(checked, 16);
});
