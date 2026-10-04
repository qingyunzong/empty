"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = require("node:assert/strict");
const node_test_1 = require("node:test");
const simulator_1 = require("../src/simulator");
function req(clock, pageId, generation, resource) {
    return { kind: "request", clock, pageId, generation, resource };
}
function rel(clock, pageId, generation, resource) {
    return { kind: "release", clock, pageId, generation, resource };
}
function crash(clock, pageId) {
    return { kind: "crash", clock, pageId };
}
function recover(clock, pageId) {
    return { kind: "recover", clock, pageId };
}
(0, node_test_1.test)("FIFO: requests are granted in logical-clock order even when delivered out of order", () => {
    const sim = new simulator_1.LockSimulator();
    // Delivered out of order; logical clocks define the real order.
    sim.deliver(req(3, "P3", 1, "A"));
    sim.deliver(req(1, "P1", 1, "A"));
    sim.deliver(req(2, "P2", 1, "A"));
    const log = sim.flush();
    (0, strict_1.deepEqual)(log.map((r) => r.outcome), ["granted", "queued", "queued"]);
    (0, strict_1.deepEqual)(log[2].ownership, { A: "P1" });
    (0, strict_1.deepEqual)(log[2].queues, { A: ["P2#1", "P3#1"] });
    sim.deliver(rel(4, "P1", 1, "A"));
    const log2 = sim.flush();
    (0, strict_1.deepEqual)(log2[0].ownership, { A: "P2" });
    (0, strict_1.deepEqual)(log2[0].queues, { A: ["P3#1"] });
    (0, strict_1.equal)(log2[0].note, "granted to next waiter P2");
    sim.deliver(rel(5, "P2", 1, "A"));
    const log3 = sim.flush();
    (0, strict_1.deepEqual)(log3[0].ownership, { A: "P3" });
    (0, strict_1.deepEqual)(log3[0].queues, {});
});
(0, node_test_1.test)("crash releases held locks and drops pending requests, waiters are granted in order", () => {
    const sim = new simulator_1.LockSimulator();
    sim.deliver(req(1, "P1", 1, "A"));
    sim.deliver(req(2, "P1", 1, "B"));
    sim.deliver(req(3, "P2", 1, "A")); // queued behind P1
    sim.deliver(req(4, "P3", 1, "B")); // queued behind P1
    sim.deliver(req(5, "P3", 1, "A")); // queued behind P2
    sim.flush();
    sim.deliver(crash(6, "P1"));
    const log = sim.flush();
    const step = log[0];
    (0, strict_1.equal)(step.outcome, "crashed");
    // Held locks went to the next waiters; P1's own queue entries are gone.
    (0, strict_1.deepEqual)(step.ownership, { A: "P2", B: "P3" });
    (0, strict_1.deepEqual)(step.queues, { A: ["P3#1"] });
    (0, strict_1.ok)(step.mutexOk);
});
(0, node_test_1.test)("recovery under the same page id starts a new generation; stale releases are rejected", () => {
    const sim = new simulator_1.LockSimulator();
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
    (0, strict_1.deepEqual)(log.map((r) => r.outcome), ["granted", "queued", "crashed", "recovered", "rejected-stale", "queued", "released"]);
    // After the stale release was rejected, P2 must still hold A.
    (0, strict_1.deepEqual)(log[4].ownership, { A: "P2" });
    // Final: P1 generation 2 owns A again.
    (0, strict_1.deepEqual)(log[6].ownership, { A: "P1" });
    (0, strict_1.deepEqual)(log[6].queues, {});
    (0, strict_1.ok)(log.every((r) => r.mutexOk));
    console.log("\n" + (0, simulator_1.renderLog)(log) + "\n");
});
(0, node_test_1.test)("stale messages from before a crash are rejected after recovery", () => {
    const sim = new simulator_1.LockSimulator();
    sim.deliver(req(1, "P1", 1, "A"));
    sim.deliver(crash(2, "P1"));
    sim.deliver(recover(3, "P1"));
    sim.deliver(req(4, "P1", 1, "B")); // old generation request
    const log = sim.flush();
    (0, strict_1.equal)(log[3].outcome, "rejected-stale");
    (0, strict_1.deepEqual)(log[3].ownership, {});
});
(0, node_test_1.test)("release by a non-holder is rejected and does not disturb the owner", () => {
    const sim = new simulator_1.LockSimulator();
    sim.deliver(req(1, "P1", 1, "A"));
    sim.deliver(rel(2, "P2", 1, "A")); // P2 never registered / holds nothing
    sim.deliver(rel(3, "P1", 1, "B")); // P1 holds A, not B
    const log = sim.flush();
    (0, strict_1.equal)(log[1].outcome, "rejected-unknown-page");
    (0, strict_1.equal)(log[2].outcome, "rejected-not-holder");
    (0, strict_1.deepEqual)(log[2].ownership, { A: "P1" });
});
(0, node_test_1.test)("non-integer logical clocks are refused", () => {
    const sim = new simulator_1.LockSimulator();
    (0, strict_1.throws)(() => sim.deliver(req(1.5, "P1", 1, "A")));
});
(0, node_test_1.test)("mutual exclusion holds under randomized out-of-order traffic", () => {
    const pages = ["P1", "P2", "P3"];
    const resources = ["A", "B"];
    for (let seed = 1; seed <= 50; seed++) {
        // Build a random but well-formed message stream with distinct clocks.
        const generation = new Map(pages.map((p) => [p, 1]));
        const alive = new Map(pages.map((p) => [p, true]));
        const clocks = (0, simulator_1.shuffled)(Array.from({ length: 40 }, (_, i) => i + 1), seed * 7 + 1);
        const messages = [];
        let randState = seed * 2654435761 >>> 0 || 1;
        const rand = () => {
            randState = (randState * 1664525 + 1013904223) >>> 0;
            return randState / 0x100000000;
        };
        for (const clock of clocks) {
            const page = pages[Math.floor(rand() * pages.length)];
            const resource = resources[Math.floor(rand() * resources.length)];
            const roll = rand();
            if (roll < 0.45) {
                messages.push(req(clock, page, generation.get(page), resource));
            }
            else if (roll < 0.75) {
                messages.push(rel(clock, page, generation.get(page), resource));
            }
            else if (roll < 0.9) {
                messages.push(crash(clock, page));
                alive.set(page, false);
            }
            else {
                if (!alive.get(page))
                    generation.set(page, generation.get(page) + 1);
                alive.set(page, true);
                messages.push(recover(clock, page));
            }
        }
        // Deliver in a shuffled (out-of-order) arrival sequence.
        const sim = new simulator_1.LockSimulator();
        for (const m of (0, simulator_1.shuffled)(messages, seed * 13 + 5))
            sim.deliver(m);
        const log = sim.flush();
        (0, strict_1.equal)(log.length, messages.length, `seed ${seed}: every message applied`);
        for (const step of log) {
            (0, strict_1.ok)(step.mutexOk, `seed ${seed} step ${step.step}: mutual exclusion`);
            const holders = Object.values(step.ownership);
            (0, strict_1.equal)(new Set(Object.keys(step.ownership)).size, Object.keys(step.ownership).length, `seed ${seed} step ${step.step}: one holder per resource`);
            (0, strict_1.ok)(holders.every((h) => pages.includes(h)), `seed ${seed}: known holder`);
        }
    }
});
