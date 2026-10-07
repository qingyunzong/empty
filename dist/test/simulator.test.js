"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const simulator_1 = require("../src/simulator");
const rng_1 = require("../src/rng");
const base = {
    probeInterval: 4,
    suspectTimeout: 6,
    suspicionTimeout: 8,
    maxDelay: 10,
    dropRate: 0.3,
    ticks: 200,
};
const rank = { ALIVE: 0, SUSPECT: 1, DEAD: 2 };
(0, node_test_1.test)("random delay reordering preserves invariants across seeds", () => {
    const signatures = new Set();
    for (let seed = 1; seed <= 50; seed++) {
        const { detector, timeline } = (0, simulator_1.runSimulation)(base, (0, rng_1.mulberry32)(seed));
        for (let i = 1; i < timeline.length; i++) {
            strict_1.default.ok(timeline[i].heartbeat >= timeline[i - 1].heartbeat, "heartbeat monotonic");
            const prev = rank[timeline[i - 1].status];
            const curr = rank[timeline[i].status];
            strict_1.default.ok(curr === prev || curr === prev + 1 || curr === 0, "only ALIVE->SUSPECT->DEAD or revival to ALIVE");
            strict_1.default.ok(!(prev === 2 && curr !== 2), "DEAD is terminal");
        }
        for (const tr of detector.transitions) {
            strict_1.default.ok(tr.reason.length > 0, "transition has rationale");
        }
        signatures.add(timeline.map((r) => r.status[0]).join(""));
    }
    strict_1.default.ok(signatures.size > 1, "random reordering produces distinct outcomes");
});
(0, node_test_1.test)("simulation is deterministic for a fixed seed", () => {
    const a = (0, simulator_1.runSimulation)(base, (0, rng_1.mulberry32)(42)).timeline;
    const b = (0, simulator_1.runSimulation)(base, (0, rng_1.mulberry32)(42)).timeline;
    strict_1.default.deepEqual(a, b);
});
(0, node_test_1.test)("no drops and short delays keep the node alive", () => {
    const { timeline, detector } = (0, simulator_1.runSimulation)({ ...base, dropRate: 0, maxDelay: 1 }, (0, rng_1.mulberry32)(7));
    strict_1.default.ok(timeline.every((r) => r.status === "ALIVE"));
    strict_1.default.equal(detector.transitions.length, 0);
});
(0, node_test_1.test)("total packet loss drives the node to DEAD via SUSPECT", () => {
    const { timeline, detector } = (0, simulator_1.runSimulation)({ ...base, dropRate: 1 }, (0, rng_1.mulberry32)(7));
    strict_1.default.equal(timeline[timeline.length - 1].status, "DEAD");
    const kinds = detector.transitions.map((t) => t.to);
    strict_1.default.ok(kinds.indexOf("SUSPECT") < kinds.indexOf("DEAD"));
    strict_1.default.equal(detector.heartbeat, 0);
});
