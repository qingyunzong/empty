import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret } from "../src/interpreter";
import { runScenario } from "../src/runner";
import type { Action, Scenario, SubscriptionSpec } from "../src/scenario";

/** Deterministic PRNG (mulberry32) so failures reproduce by seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPICS = ["t0", "t1", "t2"];

function generateScenario(seed: number): Scenario {
  const random = rng(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const names: string[] = [];
  let dynamic = 0;

  const genPlan = (ownTopicIndex: number, budget: number, length: number): Action[] => {
    const plan: Action[] = [];
    for (let i = 0; i < length; i++) {
      const r = random();
      if (r < 0.2 && ownTopicIndex < TOPICS.length - 1) {
        // Acyclic: only publish to higher-ranked topics.
        const target = ownTopicIndex + 1 + int(TOPICS.length - 1 - ownTopicIndex);
        plan.push({ do: "publish", topic: TOPICS[target] as string });
      } else if (r < 0.3) {
        plan.push({ do: "republish", maxDepth: 1 + int(2) });
      } else if (r < 0.45 && budget > 0) {
        const name = `d${dynamic++}`;
        names.push(name);
        const topicIndex = int(TOPICS.length);
        plan.push({
          do: "subscribe",
          as: name,
          topic: TOPICS[topicIndex] as string,
          plan: genPlan(topicIndex, budget - 1, int(3)),
        });
      } else if (r < 0.6 && names.length > 0) {
        plan.push({ do: "unsubscribe", name: names[int(names.length)] as string });
      } else if (r < 0.7) {
        plan.push({ do: "fail", message: `e${seed}:${i}` });
      } else if (r < 0.8) {
        plan.push({ do: "yield", ticks: 1 + int(2) });
      }
    }
    return plan;
  };

  const subscriptions: SubscriptionSpec[] = [];
  const count = 2 + int(3);
  for (let i = 0; i < count; i++) {
    const name = `s${i}`;
    const topicIndex = int(TOPICS.length);
    names.push(name);
    subscriptions.push({
      name,
      topic: TOPICS[topicIndex] as string,
      plan: genPlan(topicIndex, 2, int(4)),
    });
  }
  return { subscriptions, rootTopic: "t0" };
}

test("differential: random scenarios match the snapshot interpreter (sync and async)", async () => {
  const SEEDS = 400;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const scenario = generateScenario(seed);
    const expected = interpret(scenario);
    const sync = await runScenario(scenario, "sync");
    const async = await runScenario(scenario, "async");
    try {
      assert.deepEqual(sync.trace, [...expected.trace]);
      assert.deepEqual(sync.errors, [...expected.errors]);
      assert.equal(sync.inFlightAfter, 0);
      assert.deepEqual(async.trace, [...expected.trace]);
      assert.deepEqual(async.errors, [...expected.errors]);
      assert.equal(async.inFlightAfter, 0);
    } catch (error) {
      throw new Error(
        `seed ${seed} mismatch: ${(error as Error).message}\n` +
          `scenario: ${JSON.stringify(scenario)}`,
      );
    }
  }
});
