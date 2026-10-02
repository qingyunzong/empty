import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'src', 'cli.js');

// Runs the CLI in-process, capturing stdout/stderr writes.
function runMain(args) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let code;
  try {
    code = main(['node', 'rework-router', ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { code, stdout: out.join(''), stderr: err.join('') };
}

const scenario = {
  shifts: 3,
  lines: [{ id: 'L1', budgetPerShift: 480 }],
  stations: [
    { id: 'DIAG', lineId: 'L1', capacityPerShift: 240 },
    { id: 'REP', lineId: 'L1', capacityPerShift: 240 },
    { id: 'INSP', lineId: 'L1', capacityPerShift: 240 },
  ],
  orders: [
    { id: 'WO-1', priority: 'normal', arrivalShift: 0, route: [
      { station: 'DIAG', minutes: 60 }, { station: 'REP', minutes: 120 }, { station: 'INSP', minutes: 30 }] },
    { id: 'WO-BAD', route: [{ station: 'DIAG', minutes: -1 }] },
  ],
};

test('CLI schedules a scenario file and verifies it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rework-cli-'));
  const inputPath = join(dir, 'input.json');
  const outPath = join(dir, 'out.json');
  writeFileSync(inputPath, JSON.stringify(scenario));

  const run = runMain([inputPath, '--out', outPath, '--verify']);
  assert.equal(run.code, 0, run.stderr);
  assert.ok(existsSync(outPath));

  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.verification.ok, true);
  assert.deepEqual(result.routes.map((r) => r.orderId), ['WO-1']);
  assert.equal(result.budgetDeductions.length, 3);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'negative-minutes');
});

test('CLI prints JSON to stdout by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rework-cli-'));
  const inputPath = join(dir, 'input.json');
  writeFileSync(inputPath, JSON.stringify(scenario));

  const run = runMain([inputPath]);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.summary.scheduled, 1);
  assert.equal(result.summary.errors, 1);
});

test('CLI exits with code 2 on missing file, bad JSON, or structural errors', () => {
  assert.equal(runMain([join(tmpdir(), 'does-not-exist.json')]).code, 2);
  assert.equal(runMain([]).code, 2);

  const dir = mkdtempSync(join(tmpdir(), 'rework-cli-'));
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{not json');
  assert.equal(runMain([badJson]).code, 2);

  const badShape = join(dir, 'shape.json');
  writeFileSync(badShape, JSON.stringify({ shifts: 0, lines: [], stations: [], orders: [] }));
  const run = runMain([badShape]);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /error:/);
});

test('CLI runs the bundled example end to end', () => {
  const example = join(root, 'examples', 'input.json');
  const run = runMain([example, '--verify']);
  assert.equal(run.code, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.verification.ok, true);
  assert.ok(result.summary.scheduled >= 1);
  assert.ok(result.summary.preemptions >= 1);
  assert.ok(result.summary.rollbacks >= 1);
});

test('CLI works as a real child process (skipped when spawning is restricted)', (t) => {
  const probe = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'EPERM') {
    t.skip('child processes are not permitted in this environment');
    return;
  }
  const run = spawnSync(process.execPath, [cli, join(root, 'examples', 'input.json'), '--verify'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.verification.ok, true);
});
