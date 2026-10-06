"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const simulator_1 = require("./simulator");
const exhaustive_1 = require("./exhaustive");
const sequential_1 = require("./sequential");
function main() {
    const file = process.argv[2];
    if (!file) {
        console.error('usage: node dist/src/cli.js <scenario.json>');
        process.exitCode = 1;
        return;
    }
    const scenario = JSON.parse((0, node_fs_1.readFileSync)(file, 'utf8'));
    const shared = scenario.shared ?? {};
    if (scenario.schedule) {
        const sim = new simulator_1.Simulator(scenario.threads, shared);
        console.log(`initial: ${JSON.stringify(sim.result())}`);
        scenario.schedule.forEach((t, i) => {
            sim.step(t);
            console.log(`step ${i + 1}: run T${t} -> ${JSON.stringify(sim.result())}`);
        });
        console.log(`final (${scenario.schedule.length} steps): ${JSON.stringify(sim.result())}`);
    }
    const maxSteps = scenario.maxSteps ?? 20;
    const report = (0, exhaustive_1.enumerateSchedules)(scenario.threads, shared, maxSteps);
    console.log(`exhaustive (<= ${maxSteps} steps): ${report.exploredStates} states, ${report.results.size} distinct results`);
    for (const result of report.results.values()) {
        console.log(`  ${JSON.stringify(result)}`);
    }
    const sequential = (0, sequential_1.runSequential)(scenario.threads, shared);
    const verification = (0, sequential_1.verifySequential)(scenario.threads, shared, maxSteps);
    console.log(`sequential reference: ${JSON.stringify(sequential)}`);
    console.log(`sequential result ${verification.contained ? 'IS' : 'is NOT'} contained in the exhaustive result set`);
}
main();
