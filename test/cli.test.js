import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../src/cli.js';
import { tmpDir, writeJsonl, captureIo, BASE, MIN } from '../testlib/helpers.js';

function solve(inDir, outDir, extra = []) {
  const io = captureIo();
  const code = run(['solve', '--in', inDir, '--out', outDir, ...extra], io);
  return { code, io };
}

test('dispatch solve writes plan.json, budget.json, rework.jsonl, late.log', () => {
  const dir = tmpDir();
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  writeJsonl(inDir, [
    { type: 'carrier', eventTs: BASE, carrier: 'C1', lot: 'L1', qty: 1, op: 'A' },
    { type: 'metro', eventTs: BASE, lot: 'L1', score: 10, op: 'A' },
    { type: 'carrier', eventTs: BASE + 1 * MIN, carrier: 'C2', lot: 'L2', qty: 1, op: 'A' },
    { type: 'tool', eventTs: BASE + 10 * MIN, tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + 120 * MIN, op: 'A' },
    { type: 'metro', eventTs: BASE + 2 * MIN, lot: 'L2', score: 99, op: 'A' },
  ]);

  const { code, io } = solve(inDir, outDir);
  assert.equal(code, 0, io.err);
  assert.match(io.out, /solved: 5 events/);

  const plan = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
  const budget = JSON.parse(readFileSync(join(outDir, 'budget.json'), 'utf8'));
  const rework = readFileSync(join(outDir, 'rework.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const late = readFileSync(join(outDir, 'late.log'), 'utf8');

  assert.deepEqual(plan.objective, { score: 99, count: 1 });
  assert.equal(plan.solutions[0].assignments[0].carrier, 'C2');
  assert.equal(budget.feasible, true);
  assert.equal(budget.windows[0].remaining, 0);
  assert.ok(rework.some((r) => r.reason === 'METRO_LATE_REWRITE'));
  assert.match(late, /LATE eventTs=\d+ watermark=\d+ type=metro id=L2/);
});

test('negative cap fails with CAP_INVALID and non-zero exit', () => {
  const dir = tmpDir();
  writeJsonl(join(dir, 'in'), [
    { type: 'tool', eventTs: BASE, tool: 'T1', cap: -1, windowStart: BASE, windowEnd: BASE + MIN, op: 'A' },
  ]);
  const { code, io } = solve(join(dir, 'in'), join(dir, 'out'));
  assert.equal(code, 1);
  assert.match(io.err, /CAP_INVALID/);
});

test('metro for an unknown lot goes to pending and does not fail', () => {
  const dir = tmpDir();
  writeJsonl(join(dir, 'in'), [
    { type: 'metro', eventTs: BASE, lot: 'GHOST', score: 42, op: 'A' },
    { type: 'carrier', eventTs: BASE, carrier: 'C1', lot: 'L1', qty: 1, op: 'A' },
    { type: 'tool', eventTs: BASE, tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + MIN, op: 'A' },
  ]);
  const { code, io } = solve(join(dir, 'in'), join(dir, 'out'));
  assert.equal(code, 0, io.err);
  const plan = JSON.parse(readFileSync(join(dir, 'out', 'plan.json'), 'utf8'));
  assert.deepEqual(plan.pendingMetros, ['GHOST']);
  assert.equal(plan.solutions[0].assignments[0].score, 0, 'pending score must not leak to other lots');
});

test('pending metro applies once its lot arrives', () => {
  const dir = tmpDir();
  writeJsonl(join(dir, 'in'), [
    { type: 'metro', eventTs: BASE, lot: 'L9', score: 42, op: 'A' },
    { type: 'carrier', eventTs: BASE + 1 * MIN, carrier: 'C9', lot: 'L9', qty: 1, op: 'A' },
    { type: 'tool', eventTs: BASE + 2 * MIN, tool: 'T1', cap: 1, windowStart: BASE, windowEnd: BASE + 60 * MIN, op: 'A' },
  ]);
  const { code, io } = solve(join(dir, 'in'), join(dir, 'out'));
  assert.equal(code, 0, io.err);
  const plan = JSON.parse(readFileSync(join(dir, 'out', 'plan.json'), 'utf8'));
  assert.deepEqual(plan.pendingMetros, []);
  assert.deepEqual(plan.objective, { score: 42, count: 1 });
});

test('usage errors exit with code 2', () => {
  for (const argv of [[], ['solve'], ['bogus'], ['solve', '--in', 'x']]) {
    const io = captureIo();
    assert.equal(run(argv, io), 2, JSON.stringify(argv));
    assert.match(io.err, /usage: dispatch solve/);
  }
});
