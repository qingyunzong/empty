import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Interpreter, CycleError, valueEquals, formatValue } from '../src/index.js';
/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const COLS = 5; // A..E
const ROWS = 8; // 1..8
function randomAddr(rand) {
    const col = Math.floor(rand() * COLS);
    const row = 1 + Math.floor(rand() * ROWS);
    return String.fromCharCode(65 + col) + String(row);
}
function randomFormula(rand, depth) {
    const r = rand();
    if (depth <= 0 || r < 0.3) {
        if (rand() < 0.55)
            return String(Math.floor(rand() * 21) - 5); // -5..15
        return randomAddr(rand);
    }
    if (r < 0.45) {
        // IF with a comparison or arithmetic condition
        const cond = rand() < 0.5
            ? `(${randomFormula(rand, 0)})<(${randomFormula(rand, 0)})`
            : randomFormula(rand, depth - 1);
        return `IF(${cond}, ${randomFormula(rand, depth - 1)}, ${randomFormula(rand, depth - 1)})`;
    }
    const ops = ['+', '-', '*', '/', '/', '=', '<', '>']; // extra '/' to spawn DIV/0 errors
    const op = ops[Math.floor(rand() * ops.length)];
    return `(${randomFormula(rand, depth - 1)})${op}(${randomFormula(rand, depth - 1)})`;
}
function runFuzz(seed, ops) {
    const rand = mulberry32(seed);
    const engine = new Engine();
    const oracle = new Interpreter();
    let applied = 0;
    let cycles = 0;
    let clears = 0;
    for (let step = 0; step < ops; step++) {
        const addr = randomAddr(rand);
        const formula = rand() < 0.15 ? null : `=${randomFormula(rand, 3)}`;
        if (formula === null)
            clears++;
        let engineThrew = false;
        try {
            engine.setCell(addr, formula);
        }
        catch (e) {
            assert.ok(e instanceof CycleError, `engine threw non-cycle error: ${String(e)}`);
            engineThrew = true;
            cycles++;
        }
        let oracleThrew = false;
        try {
            oracle.setCell(addr, formula);
        }
        catch (e) {
            assert.ok(e instanceof CycleError, `oracle threw non-cycle error: ${String(e)}`);
            oracleThrew = true;
        }
        assert.equal(engineThrew, oracleThrew, `cycle detection mismatch at step ${step} (seed ${seed}, ${addr} := ${formula})`);
        if (engineThrew)
            continue;
        applied++;
        const expected = oracle.evaluateAll();
        const actual = new Map(engine.allValues());
        const keys = new Set([...expected.keys(), ...actual.keys()]);
        for (const key of keys) {
            const a = actual.get(key);
            const b = expected.get(key);
            assert.ok(a !== undefined && b !== undefined && valueEquals(a, b), `mismatch at step ${step} (seed ${seed}) cell ${key}: ` +
                `engine=${a ? formatValue(a) : '<missing>'} oracle=${b ? formatValue(b) : '<missing>'}`);
        }
    }
    return { applied, cycles, clears };
}
describe('differential fuzz: incremental engine vs full-table interpreter', () => {
    const SEEDS = 30;
    const OPS_PER_SEED = 400;
    test('random workloads produce identical tables', () => {
        let applied = 0;
        let cycles = 0;
        let clears = 0;
        for (let seed = 1; seed <= SEEDS; seed++) {
            const r = runFuzz(seed, OPS_PER_SEED);
            applied += r.applied;
            cycles += r.cycles;
            clears += r.clears;
        }
        console.log(`  [fuzz] seeds=${SEEDS} ops/seed=${OPS_PER_SEED} ` +
            `applied=${applied} rejectedCycles=${cycles} clears=${clears}`);
        assert.ok(applied > 0);
    });
});
