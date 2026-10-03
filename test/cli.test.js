import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIN = 60_000;
const T = 1_700_000_000_000;
const DUE = T + 8 * 3600 * 1000;
const BIN = fileURLToPath(new URL('../bin/plan.js', import.meta.url));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
}

function runCli(inDir, outDir) {
  return spawnSync(process.execPath, [BIN, 'run', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
}

const order = (job, mold, eventTs, extra = {}) => ({
  type: 'order', arriveTs: eventTs, eventTs, job, mold, due: DUE, qty: 5, op: 1, ...extra,
});

// Acceptance 4: due earlier than eventTs -> DUE_INVALID, non-zero exit, error.json.
test('due earlier than eventTs exits non-zero with DUE_INVALID', () => {
  const inDir = tmpdir();
  const outDir = tmpdir();
  fs.writeFileSync(
    path.join(inDir, 'events.jsonl'),
    `${JSON.stringify(order('J1', 'A', T, { due: T - 1 }))}\n`,
  );
  const r = runCli(inDir, outDir);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(fs.readFileSync(path.join(outDir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'DUE_INVALID');
  assert.match(err.msg, /J1/);
  assert.equal(fs.existsSync(path.join(outDir, 'schedule.json')), false);
});

// Acceptance 1 via CLI: schedule.json / corrections.json / late.log are written.
test('cli run writes schedule, corrections and late.log', () => {
  const inDir = tmpdir();
  const outDir = tmpdir();
  const lines = [
    order('J1', 'A', T),
    order('J2', 'A', T + 10 * MIN),
    order('J3', 'B', T + 1 * MIN),
    order('J4', 'B', T + 2 * MIN),
    order('J5', 'C', T + 3 * MIN),
    { type: 'retract', eventTs: T + 4 * MIN, kind: 'order', id: 'GHOST' },
  ];
  fs.writeFileSync(path.join(inDir, 'events.jsonl'), `${lines.map(JSON.stringify).join('\n')}\n`);
  const r = runCli(inDir, outDir);
  assert.equal(r.status, 0, r.stderr);

  const schedule = JSON.parse(fs.readFileSync(path.join(outDir, 'schedule.json'), 'utf8'));
  assert.equal(schedule.watermark, T + 8 * MIN);
  assert.equal(schedule.horizonEnd, schedule.t0 + 8 * 3600 * 1000);
  assert.ok(schedule.schedules.length >= 1);
  assert.deepEqual(schedule.schedules[0].map((p) => p.job).sort(), ['J1', 'J2', 'J3', 'J4', 'J5']);

  const corrections = JSON.parse(fs.readFileSync(path.join(outDir, 'corrections.json'), 'utf8'));
  assert.equal(corrections.length, 3);

  const lateLog = fs.readFileSync(path.join(outDir, 'late.log'), 'utf8');
  assert.match(lateLog, /GHOST/);
});

test('malformed JSONL exits non-zero with PARSE_ERROR', () => {
  const inDir = tmpdir();
  const outDir = tmpdir();
  fs.writeFileSync(path.join(inDir, 'bad.jsonl'), '{"type":"order"\n');
  const r = runCli(inDir, outDir);
  assert.notEqual(r.status, 0);
  const err = JSON.parse(fs.readFileSync(path.join(outDir, 'error.json'), 'utf8'));
  assert.equal(err.code, 'PARSE_ERROR');
});
