"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const simulator_1 = require("../src/simulator");
const reference_1 = require("../src/reference");
const rng_1 = require("../src/rng");
const scenarios = [
    { probeInterval: 4, suspectTimeout: 6, suspicionTimeout: 8, maxDelay: 10, dropRate: 0.3, ticks: 200 },
    { probeInterval: 3, suspectTimeout: 4, suspicionTimeout: 4, maxDelay: 12, dropRate: 0.5, ticks: 150 },
    { probeInterval: 5, suspectTimeout: 5, suspicionTimeout: 10, maxDelay: 2, dropRate: 0.1, ticks: 120 },
    { probeInterval: 2, suspectTimeout: 3, suspicionTimeout: 3, maxDelay: 6, dropRate: 0.7, ticks: 100 },
];
(0, node_test_1.test)("single-node simulator matches the reference model across seeds and configs", () => {
    for (const cfg of scenarios) {
        for (let seed = 1; seed <= 50; seed++) {
            const { timeline, events } = (0, simulator_1.runSimulation)(cfg, (0, rng_1.mulberry32)(seed));
            const expected = (0, reference_1.replayReference)(cfg, events);
            strict_1.default.deepEqual(timeline, expected, `mismatch for seed ${seed}`);
        }
    }
});
