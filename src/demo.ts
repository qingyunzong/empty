import { LockSimulator, type SimEvent } from "./lock-sim.js";

// Out-of-order events with integer logical clocks.
const events: SimEvent[] = [
  { clock: 9, type: "release", pageId: "B", lock: "L1", generation: 1 },
  { clock: 2, type: "request", pageId: "B", lock: "L1", generation: 1 },
  { clock: 7, type: "recover", pageId: "A" },
  { clock: 1, type: "request", pageId: "A", lock: "L1", generation: 1 },
  { clock: 8, type: "request", pageId: "A", lock: "L1", generation: 2 },
  { clock: 5, type: "release", pageId: "A", lock: "L1", generation: 1 },
  { clock: 6, type: "crash", pageId: "A" },
  { clock: 4, type: "request", pageId: "C", lock: "L1", generation: 1 },
  { clock: 3, type: "request", pageId: "A", lock: "L2", generation: 1 },
  { clock: 10, type: "release", pageId: "A", lock: "L1", generation: 1 }, // stale, rejected
];

const sim = new LockSimulator();
sim.run(events);
console.log(sim.formatHistory());
console.log("\nmutual exclusion verified:", sim.verifyMutualExclusion());
