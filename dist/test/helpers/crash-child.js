// Child-process harness for power-loss tests. It runs a linear pipeline
// A -> B -> C -> D where B reads an input file, and can be told (via env) to
// die abruptly at a precise crash point, simulating power loss.
//
// Usage: node dist/test/helpers/crash-child.js <stateDir> <cacheDir>
// Env:   CRASH_STAGE=B CRASH_PHASE=after-publish|tmp-written|before-run
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Executor } from '../../src/index.js';
const [stateDir, cacheDir] = process.argv.slice(2);
if (!stateDir || !cacheDir) {
    console.error('usage: crash-child <stateDir> <cacheDir>');
    process.exit(64);
}
const logPath = join(stateDir, 'executions.log');
const inputFile = join(stateDir, 'input.txt');
writeFileSync(inputFile, readEnvDefault('INPUT_CONTENT', 'seed'));
function readEnvDefault(name, fallback) {
    return process.env[name] ?? fallback;
}
function log(line) {
    appendFileSync(logPath, `${line}\n`);
}
const stage = (id, deps = [], inputs = []) => ({
    id,
    deps,
    inputs,
    run: (ctx) => {
        log(`executed ${id}`);
        const suffix = inputs.length > 0 ? `:${ctx.inputs[inputs[0]]}` : '';
        return `${id}-out${suffix}`;
    },
});
const stages = [
    stage('A'),
    stage('B', ['A'], [inputFile]),
    stage('C', ['B']),
    stage('D', ['C']),
];
const crashStage = process.env['CRASH_STAGE'];
const crashPhase = process.env['CRASH_PHASE'];
const executor = new Executor(stages, {
    cacheDir,
    hooks: {
        crashAt: crashStage ? { stageId: crashStage, phase: crashPhase } : undefined,
        // default crash behaviour: process.exit(1) — a hard, cleanup-free stop.
    },
});
const report = await executor.run();
log(`report ok=${report.ok}`);
process.exit(report.ok ? 0 : 2);
