import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";
import { LockMessage } from "../src/lock-manager";
import { LockSimulator, renderLog, shuffled } from "../src/simulator";

function req(clock: number, pageId: string, generation: number, resource: string): LockMessage {
  return { kind: "request", clock, pageId, generation, resource };
}
function rel(clock: number, pageId: string, generation: number, resource: string): LockMessage {
  return { kind: "release", clock, pageId, generation, resource };
}
function crash(clock: number, pageId: string): LockMessage {
  return { kind: "crash", clock, pageId };
}
function recover(clock: number, pageId: string): LockMessage {
  return { kind: "recover", clock, pageId };
}

test("FIFO: requests are granted in logical-clock order even when delivered out of order", () => {
  const sim = new LockSimulator();
  // Delivered out of order; logical clocks define the real order.
  sim.deliver(req(3, "P3", 1, "A"));
  sim.deliver(req(1, "P1", 1, "A"));
  sim.deliver(req(2, "P2", 1, "A"));
  const log = sim.flush();

  deepEqual(log.map((r) => r.outcome), ["granted", "queued", "queued"]);
  deepEqual(log[2]!.ownership, { A: "P1" });
  deepEqual(log[2]!.queues, { A: ["P2#1", "P3#1"] });

  sim.deliver(rel(4, "P1", 1, "A"));
  const log2 = sim.flush();
  deepEqual(log2[0]!.ownership, { A: "P2" });
  deepEqual(log2[0]!.queues, { A: ["P3#1"] });
  equal(log2[0]!.note, "granted to next waiter P2");

  sim.deliver(rel(5, "P2", 1, "A"));
  const log3 = sim.flush();
  deepEqual(log3[0]!.ownership, { A: "P3" });
  deepEqual(log3[0]!.queues, {});
});

test("crash releases held locks and drops pending requests, waiters are granted in order", () => {
  const sim = new LockSimulator();
  sim.deliver(req(1, "P1", 1, "A"));
  sim.deliver(req(2, "P1", 1, "B"));
  sim.deliver(req(3, "P2", 1, "A")); // queued behind P1
  sim.deliver(req(4, "P3", 1, "B")); // queued behind P1
  sim.deliver(req(5, "P3", 1, "A")); // queued behind P2
  sim.flush();

  sim.deliver(crash(6, "P1"));
  const log = sim.flush();
  const step = log[0]!;
  equal(step.outcome, "crashed");
  // Held locks went to the next waiters; P1's own queue entries are gone.
  deepEqual(step.ownership, { A: "P2", B: "P3" });
  deepEqual(step.queues, { A: ["P3#1"] });
  ok(step.mutexOk);
});

test("recovery under the same page id starts a new generation; stale releases are rejected", () => {
  const sim = new LockSimulator();
  sim.deliver(req(1, "P1", 1, "A"));
  sim.deliver(req(2, "P2", 1, "A")); // queued
  sim.deliver(crash(3, "P1")); // A passes to P2
  sim.deliver(recover(4, "P1")); // P1 back as generation 2
  // A release that P1's old generation sent before crashing arrives late:
  sim.deliver(rel(5, "P1", 1, "A"));
  // The recovered page can lock again under its new generation:
  sim.deliver(req(6, "P1", 2, "A")); // queued behind P2
  sim.deliver(rel(7, "P2", 1, "A")); // P2 releases -> P1#2 granted
  const log = sim.flush();

  deepEqual(
    log.map((r) => r.outcome),
    ["granted", "queued", "crashed", "recovered", "rejected-stale", "queued", "released"],
  );
  // After the stale release was rejected, P2 must still hold A.
  deepEqual(log[4]!.ownership, { A: "P2" });
  // Final: P1 generation 2 owns A again.
  deepEqual(log[6]!.ownership, { A: "P1" });
  deepEqual(log[6]!.queues, {});
  ok(log.every((r) => r.mutexOk));

  console.log("\n" + renderLog(log) + "\n");
});

test("stale messages from before a crash are rejected after recovery", () => {
  const sim = new LockSimulator();
  sim.deliver(req(1, "P1", 1, "A"));
  sim.deliver(crash(2, "P1"));
  sim.deliver(recover(3, "P1"));
  sim.deliver(req(4, "P1", 1, "B")); // old generation request
  const log = sim.flush();
  equal(log[3]!.outcome, "rejected-stale");
  deepEqual(log[3]!.ownership, {});
});

test("release by a non-holder is rejected and does not disturb the owner", () => {
  const sim = new LockSimulator();
  sim.deliver(req(1, "P1", 1, "A"));
  sim.deliver(rel(2, "P2", 1, "A")); // P2 never registered / holds nothing
  sim.deliver(rel(3, "P1", 1, "B")); // P1 holds A, not B
  const log = sim.flush();
  equal(log[1]!.outcome, "rejected-unknown-page");
  equal(log[2]!.outcome, "rejected-not-holder");
  deepEqual(log[2]!.ownership, { A: "P1" });
});

test("non-integer logical clocks are refused", () => {
  const sim = new LockSimulator();
  throws(() => sim.deliver(req(1.5, "P1", 1, "A")));
});

test("mutual exclusion holds under randomized out-of-order traffic", () => {
  const pages = ["P1", "P2", "P3"];
  const resources = ["A", "B"];

  for (let seed = 1; seed <= 50; seed++) {
    // Build a random but well-formed message stream with distinct clocks.
    const generation = new Map(pages.map((p) => [p, 1]));
    const alive = new Map(pages.map((p) => [p, true]));
    const clocks = shuffled(
      Array.from({ length: 40 }, (_, i) => i + 1),
      seed * 7 + 1,
    );
    const messages: LockMessage[] = [];
    let randState = seed * 2654435761 >>> 0 || 1;
    const rand = (): number => {
      randState = (randState * 1664525 + 1013904223) >>> 0;
      return randState / 0x100000000;
    };
    for (const clock of clocks) {
      const page = pages[Math.floor(rand() * pages.length)]!;
      const resource = resources[Math.floor(rand() * resources.length)]!;
      const roll = rand();
      if (roll < 0.45) {
        messages.push(req(clock, page, generation.get(page)!, resource));
      } else if (roll < 0.75) {
        messages.push(rel(clock, page, generation.get(page)!, resource));
      } else if (roll < 0.9) {
        messages.push(crash(clock, page));
        alive.set(page, false);
      } else {
        if (!alive.get(page)!) generation.set(page, generation.get(page)! + 1);
        alive.set(page, true);
        messages.push(recover(clock, page));
      }
    }

    // Deliver in a shuffled (out-of-order) arrival sequence.
    const sim = new LockSimulator();
    for (const m of shuffled(messages, seed * 13 + 5)) sim.deliver(m);
    const log = sim.flush();

    equal(log.length, messages.length, `seed ${seed}: every message applied`);
    for (const step of log) {
      ok(step.mutexOk, `seed ${seed} step ${step.step}: mutual exclusion`);
      const holders = Object.values(step.ownership);
      equal(
        new Set(Object.keys(step.ownership)).size,
        Object.keys(step.ownership).length,
        `seed ${seed} step ${step.step}: one holder per resource`,
      );
      ok(holders.every((h) => pages.includes(h)), `seed ${seed}: known holder`);
    }
  }
});
