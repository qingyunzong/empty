"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resultKey = resultKey;
exports.enumerateSchedules = enumerateSchedules;
const simulator_1 = require("./simulator");
function resultKey(result) {
    return JSON.stringify(result);
}
function stateKey(sim) {
    return JSON.stringify({
        steps: sim.steps,
        shared: sim.shared,
        locks: sim.locks,
        threads: sim.threads.map((t) => [t.pc, t.locals, t.done]),
    });
}
function enumerateSchedules(programs, initialShared = {}, maxSteps = 20) {
    const results = new Map();
    const visited = new Set();
    let exploredStates = 0;
    function dfs(sim) {
        const key = stateKey(sim);
        if (visited.has(key))
            return;
        visited.add(key);
        exploredStates++;
        if (sim.status() !== 'running' || sim.steps >= maxSteps) {
            const result = sim.result();
            results.set(resultKey(result), result);
            return;
        }
        for (let t = 0; t < sim.programs.length; t++) {
            if (!sim.isRunnable(t))
                continue;
            const next = sim.clone();
            next.step(t);
            dfs(next);
        }
    }
    dfs(new simulator_1.Simulator(programs, initialShared));
    return { maxSteps, exploredStates, results };
}
