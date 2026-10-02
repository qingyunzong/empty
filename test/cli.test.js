import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, main } from '../src/cli.js';
import { DispatchError } from '../src/errors.js';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const M = 60_000;
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();

function setup(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(join(inDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { inDir, outDir };
}

function captureStderr(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(' '));
  try {
    return { code: fn(), stderr: lines.join('\n') };
  } finally {
    console.error = orig;
  }
}

test('CLI solve writes plan.json, budget.json, rework.jsonl, late.log', () => {
  const { inDir, outDir } = setup([
    { eventTs: iso(T0), tool: 'T1', cap: 10, windowStart: iso(T0), windowEnd: iso(T0 + 2 * H), op: 'add' },
    { eventTs: iso(T0), lot: 'L1', score: 2, op: 'add' },
    { eventTs: iso(T0), carrier: 'C1', lot: 'L1', qty: 6, op: 'add' },
    { eventTs: iso(T0 + M), carrier: 'C2', lot: 'L2', qty: 6, op: 'add' },
    { eventTs: iso(T0 + 30 * M), lot: 'L2', score: 5, op: 'add' },
    { eventTs: iso(T0 + 40 * M), lot: 'L1', score: 9, op: 'add' },
  ]);
  assert.equal(run(['solve', '--in', inDir, '--out', outDir]), 0);
  for (const f of ['plan.json', 'budget.json', 'rework.jsonl', 'late.log']) {
    assert.ok(existsSync(join(outDir, f)), `${f} written`);
  }
  const plan = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
  assert.equal(plan.objective, 54); // C1 wins after L1 score rises to 9
  assert.deepEqual(plan.assignments.map((a) => a.carrier), ['C1']);
  const budget = JSON.parse(readFileSync(join(outDir, 'budget.json'), 'utf8'));
  assert.equal(budget.windows[0].remaining, 4);
  assert.ok(budget.windows[0].remaining >= 0);
});

test('CLI: late metro recorded in late.log and rework.jsonl', () => {
  const { inDir, outDir } = setup([
    { eventTs: iso(T0), tool: 'T1', cap: 10, windowStart: iso(T0), windowEnd: iso(T0 + 2 * H), op: 'add' },
    { eventTs: iso(T0), lot: 'L1', score: 1, op: 'add' },
    { eventTs: iso(T0), carrier: 'C1', lot: 'L1', qty: 10, op: 'add' },
    { eventTs: iso(T0 + M), carrier: 'C2', lot: 'L2', qty: 10, op: 'add' },
    { eventTs: iso(T0 + 30 * M), carrier: 'C3', lot: 'L3', qty: 1, op: 'add' },
    { eventTs: iso(T0 + 2 * M), lot: 'L2', score: 100, op: 'add' }, // late
  ]);
  assert.equal(run(['solve', '--in', inDir, '--out', outDir]), 0);
  const late = readFileSync(join(outDir, 'late.log'), 'utf8');
  assert.match(late, /LATE type=metro id=L2/);
  const rework = readFileSync(join(outDir, 'rework.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rework.some((x) => x.type === 'replan' && x.trigger === 'late_metro_add' && x.after > x.before));
  const plan = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.assignments.map((a) => a.carrier), ['C2']);
});

test('CLI: cap < 0 exits non-zero with CAP_INVALID', () => {
  const { inDir, outDir } = setup([
    { eventTs: iso(T0), tool: 'T1', cap: -3, windowStart: iso(T0), windowEnd: iso(T0 + H), op: 'add' },
  ]);
  assert.throws(() => run(['solve', '--in', inDir, '--out', outDir]), (err) => {
    assert.ok(err instanceof DispatchError);
    assert.equal(err.code, 'CAP_INVALID');
    return true;
  });
  const r = captureStderr(() => main(['solve', '--in', inDir, '--out', outDir]));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /CAP_INVALID/);
});

test('CLI: usage error without args', () => {
  const r = captureStderr(() => main([]));
  assert.equal(r.code, 64);
  assert.match(r.stderr, /usage: dispatch solve/);
});

test('CLI: multiple jsonl files in --in dir are merged in name order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(join(inDir, '01-tools.jsonl'), JSON.stringify({
    eventTs: iso(T0), tool: 'T1', cap: 3, windowStart: iso(T0), windowEnd: iso(T0 + H), op: 'add',
  }) + '\n');
  writeFileSync(join(inDir, '02-carriers.jsonl'), [
    JSON.stringify({ eventTs: iso(T0), lot: 'L1', score: 4, op: 'add' }),
    JSON.stringify({ eventTs: iso(T0), carrier: 'C1', lot: 'L1', qty: 3, op: 'add' }),
  ].join('\n') + '\n');
  assert.equal(run(['solve', '--in', inDir, '--out', outDir]), 0);
  const plan = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.assignments.map((a) => [a.carrier, a.tool]), [['C1', 'T1']]);
});
