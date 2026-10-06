"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSequential = runSequential;
exports.verifySequential = verifySequential;
const simulator_1 = require("./simulator");
const exhaustive_1 = require("./exhaustive");
const SEQUENTIAL_STEP_LIMIT = 10000;
function runSequential(programs, initialShared = {}) {
    const sim = new simulator_1.Simulator(programs, initialShared);
    let executed = 0;
    for (let t = 0; t < programs.length; t++) {
        while (!sim.threads[t].done) {
            if (!sim.isRunnable(t) || executed >= SEQUENTIAL_STEP_LIMIT)
                return sim.result();
            sim.step(t);
            executed++;
        }
    }
    return sim.result();
}
function verifySequential(programs, initialShared = {}, maxSteps = 20) {
    const sequential = runSequential(programs, initialShared);
    const report = (0, exhaustive_1.enumerateSchedules)(programs, initialShared, maxSteps);
    return {
        sequential,
        contained: report.results.has((0, exhaustive_1.resultKey)(sequential)),
        resultCount: report.results.size,
    };
}
