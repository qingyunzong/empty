'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { iso } = require('./helpers');

const CLI = path.join(__dirname, '..', 'cli.js');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
}

function writeInputs(dir, { lots, edges = [], tests = [], corrections = null }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lots.json'), JSON.stringify(lots));
  fs.writeFileSync(path.join(dir, 'edges.jsonl'), edges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'tests.jsonl'), tests.map((t) => JSON.stringify(t)).join('\n') + '\n');
  if (corrections !== null) {
    fs.writeFileSync(path.join(dir, 'corrections.jsonl'), corrections.map((c) => JSON.stringify(c)).join('\n') + '\n');
  }
}

function runCli(inDir, outDir) {
  return spawnSync(process.execPath, [CLI, 'trace', '--in', inDir, '--out', outDir], { encoding: 'utf8' });
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
}

test('happy path: trace.json with statuses and certificate hashes', () => {
  const inDir = makeDir();
  const outDir = path.join(makeDir(), 'out');
  writeInputs(inDir, {
    lots: [
      { id: 'RM', type: 'raw_material', production_start: iso(0), production_end: iso(1) },
      { id: 'FG', type: 'finished_good', production_start: iso(2), production_end: iso(3) },
    ],
    edges: [{ from: 'RM', to: 'FG' }],
    tests: [{ id: 'T1', lot: 'RM', result: 'pass' }],
  });
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);
  const trace = JSON.parse(fs.readFileSync(path.join(outDir, 'trace.json'), 'utf8'));
  assert.equal(trace.finished_goods.FG.status, 'PASS');
  assert.match(trace.finished_goods.FG.certificate_hash, /^[0-9a-f]{64}$/);
  const certs = readJsonl(path.join(outDir, 'certificates.jsonl'));
  assert.equal(certs.length, 1);
  assert.equal(certs[0].state, 'active');
  assert.equal(certs[0].hash, trace.finished_goods.FG.certificate_hash);
  assert.equal(fs.existsSync(path.join(outDir, 'errors.jsonl')), false);
});

test('cycle is rejected with exit 2 and no partial certificates', () => {
  const inDir = makeDir();
  const outDir = path.join(makeDir(), 'out');
  writeInputs(inDir, {
    lots: [
      { id: 'A', type: 'intermediate' },
      { id: 'B', type: 'finished_good' },
    ],
    edges: [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'A' },
    ],
  });
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 2);
  const errors = readJsonl(path.join(outDir, 'errors.jsonl'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'cycle_detected');
  assert.match(errors[0].message, /A -> B -> A/);
  assert.equal(fs.existsSync(path.join(outDir, 'trace.json')), false);
  assert.equal(fs.existsSync(path.join(outDir, 'certificates.jsonl')), false);
});

test('edge referencing a missing lot is rejected with exit 2', () => {
  const inDir = makeDir();
  const outDir = path.join(makeDir(), 'out');
  writeInputs(inDir, {
    lots: [{ id: 'A', type: 'finished_good' }],
    edges: [{ from: 'GHOST', to: 'A' }],
  });
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 2);
  const errors = readJsonl(path.join(outDir, 'errors.jsonl'));
  assert.equal(errors[0].error, 'unknown_lot');
  assert.equal(fs.existsSync(path.join(outDir, 'trace.json')), false);
});

test('correction targeting a missing test is reported in errors.jsonl with exit 2', () => {
  const inDir = makeDir();
  const outDir = path.join(makeDir(), 'out');
  writeInputs(inDir, {
    lots: [{ id: 'FG', type: 'finished_good' }],
    tests: [{ id: 'T1', lot: 'FG', result: 'pass' }],
    corrections: [{ type: 'revoke_test', test_id: 'NOPE' }],
  });
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 2);
  const errors = readJsonl(path.join(outDir, 'errors.jsonl'));
  assert.equal(errors[0].error, 'unknown_test');
  // Non-fatal: trace output is still produced.
  const trace = JSON.parse(fs.readFileSync(path.join(outDir, 'trace.json'), 'utf8'));
  assert.equal(trace.finished_goods.FG.status, 'PASS');
  assert.equal(trace.corrections_rejected, 1);
});

test('end to end: corrections update trace.json and keep the revocation chain', () => {
  const inDir = makeDir();
  const outDir = path.join(makeDir(), 'out');
  writeInputs(inDir, {
    lots: [
      { id: 'RM', type: 'raw_material', production_start: iso(0), production_end: iso(1) },
      { id: 'FG', type: 'finished_good', production_start: iso(2), production_end: iso(3) },
    ],
    edges: [{ from: 'RM', to: 'FG', valid_from: iso(0), valid_to: iso(10) }],
    tests: [
      { id: 'T1', lot: 'RM', result: 'fail' },
      { id: 'T2', lot: 'RM', result: 'pass' },
    ],
    corrections: [{ type: 'revoke_test', test_id: 'T1' }],
  });
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);
  const trace = JSON.parse(fs.readFileSync(path.join(outDir, 'trace.json'), 'utf8'));
  assert.equal(trace.finished_goods.FG.status, 'PASS');
  assert.equal(trace.corrections_applied, 1);
  const certs = readJsonl(path.join(outDir, 'certificates.jsonl'));
  assert.equal(certs.length, 2);
  assert.equal(certs[0].state, 'revoked');
  assert.equal(certs[0].status, 'FAIL');
  assert.equal(certs[0].superseded_by, certs[1].hash);
  assert.equal(certs[1].state, 'active');
  assert.equal(certs[1].hash, trace.finished_goods.FG.certificate_hash);
});
