import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/plan.js', import.meta.url));
const T0 = Date.UTC(2026, 9, 2, 14, 0, 0);
const H = 3600 * 1000;
const M = 60 * 1000;

function setup(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const inDir = path.join(dir, 'in');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(inDir);
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { inDir, outDir };
}

function run(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
}

const order = (job, mold, qty, eventTs, opts = {}) =>
  JSON.stringify({
    type: 'order',
    arriveTs: eventTs,
    eventTs,
    job,
    mold,
    due: opts.due ?? T0 + 8 * H,
    qty,
    op: 'add',
  });

test('happy path writes schedule.json, corrections.json and late.log', () => {
  const { inDir, outDir } = setup([
    order('A', 'M1', 20, T0),
    order('B', 'M2', 10, T0 + 30 * M),
    order('X', 'M1', 10, T0 + 2 * H + 10 * M),
    order('C', 'M1', 10, T0 + 10 * M), // late but retractable -> correction
    JSON.stringify({ type: 'retract', eventTs: T0 + 5 * M, kind: 'order', id: 'A' }), // late -> late.log
  ]);
  const res = run(['run', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 0, res.stderr);

  const schedule = JSON.parse(fs.readFileSync(path.join(outDir, 'schedule.json'), 'utf8'));
  assert.equal(schedule.horizonStart, T0);
  assert.equal(schedule.horizonEnd, T0 + 8 * H);
  assert.equal(schedule.objective.violations, 0);
  assert.ok(schedule.ties >= 1);
  assert.equal(schedule.sequences.length, schedule.ties);

  const corrections = JSON.parse(fs.readFileSync(path.join(outDir, 'corrections.json'), 'utf8'));
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].trigger.id, 'C');

  const late = fs.readFileSync(path.join(outDir, 'late.log'), 'utf8').trim().split('\n');
  assert.equal(late.length, 1);
  assert.equal(JSON.parse(late[0]).reason, 'LATE_NON_RETRACTABLE');
});

test('acceptance 4: due earlier than event time exits non-zero with DUE_INVALID', () => {
  const { inDir, outDir } = setup([order('BAD', 'M1', 10, T0, { due: T0 - 1 })]);
  const res = run(['run', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 1);
  const err = JSON.parse(fs.readFileSync(path.join(outDir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'DUE_INVALID');
  assert.match(err.msg, /BAD/);
});

test('malformed JSON line exits non-zero with PARSE_ERROR', () => {
  const { inDir, outDir } = setup(['this is not json']);
  const res = run(['run', '--in', inDir, '--out', outDir]);
  assert.equal(res.status, 1);
  const err = JSON.parse(fs.readFileSync(path.join(outDir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'PARSE_ERROR');
});

test('missing input directory exits non-zero with INPUT_NOT_FOUND', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const res = run(['run', '--in', path.join(dir, 'nope'), '--out', path.join(dir, 'out')]);
  assert.equal(res.status, 1);
  const err = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'error.json'), 'utf8'));
  assert.equal(err.code, 'INPUT_NOT_FOUND');
});

test('usage errors exit with code 2', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['run', '--in', 'x']).status, 2);
});
