import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'trace.js');

// This sandbox cannot pipe grandchild node stdout, so capture via files.
let captureSeq = 0;
function run(args, cwd) {
  captureSeq += 1;
  const outPath = join(cwd, `.cap-${captureSeq}.out`);
  const errPath = join(cwd, `.cap-${captureSeq}.err`);
  const outFd = openSync(outPath, 'w');
  const errFd = openSync(errPath, 'w');
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    stdio: ['ignore', outFd, errFd],
  });
  closeSync(outFd);
  closeSync(errFd);
  return {
    status: result.status,
    stdout: readFileSync(outPath, 'utf8'),
    stderr: readFileSync(errPath, 'utf8'),
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const input = join(dir, 'input.jsonl');
  writeFileSync(input, [
    '{"type":"charge","batch":"RM1"}',
    '{"type":"charge","batch":"RM2"}',
    '{"type":"inspect","id":"I1","batch":"RM1","status":"fail"}',
    '{"type":"mix","inputs":["RM1","RM2"],"output":"WIP1"}',
    '{"type":"split","input":"WIP1","outputs":["FG1","FG2"]}',
    '{"type":"charge","batch":"RM3"}',
    '{"type":"inspect","id":"I2","batch":"RM3","status":"under-review"}',
    '{"type":"split","input":"RM3","outputs":["FG3"]}',
    '',
  ].join('\n'));
  return { dir, input };
}

test('CLI happy path: build -> recall -> correct -> recall -> verify', () => {
  const { dir, input } = fixture();
  const state = join(dir, 'state.json');
  const cert = join(dir, 'cert.json');

  let r = run(['build', input, '--state', state], dir);
  assert.equal(r.status, 0, r.stderr);
  const built = JSON.parse(r.stdout);
  assert.equal(built.batches, 7);
  assert.deepEqual(built.sources, ['RM1']);

  r = run(['recall', '--state', state, '--out', cert], dir);
  assert.equal(r.status, 0, r.stderr);
  let certificate = JSON.parse(readFileSync(cert, 'utf8'));
  assert.equal(certificate.ruleVersion, '1.0.0');
  assert.deepEqual(certificate.boundary.affectedProducts, ['FG1', 'FG2']);
  assert.ok(!certificate.contaminated.includes('FG3'), 'unknown status is not a fail');

  r = run(['correct', '--state', state, '--batch', 'RM1', '--status', 'pass', '--id', 'C1', '--corrects', 'I1'], dir);
  assert.equal(r.status, 0, r.stderr);
  const correction = JSON.parse(r.stdout);
  assert.deepEqual([...correction.changed].sort(), ['FG1', 'FG2', 'RM1', 'WIP1']);

  r = run(['recall', '--state', state, '--out', cert], dir);
  certificate = JSON.parse(readFileSync(cert, 'utf8'));
  assert.deepEqual(certificate.contaminated, []);
  assert.deepEqual(certificate.boundary.affectedProducts, []);

  r = run(['verify', '--state', state, '--cert', cert], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test('CLI verify exits 1 on tampered certificate', () => {
  const { dir, input } = fixture();
  const state = join(dir, 'state.json');
  const cert = join(dir, 'cert.json');
  run(['build', input, '--state', state], dir);
  run(['recall', '--state', state, '--out', cert], dir);
  const tampered = JSON.parse(readFileSync(cert, 'utf8'));
  tampered.boundary.sources = ['RM2'];
  writeFileSync(cert, JSON.stringify(tampered));
  const r = run(['verify', '--state', state, '--cert', cert], dir);
  assert.equal(r.status, 1);
  assert.ok(JSON.parse(r.stderr).mismatches.includes('boundary'));
});

test('CLI build exits 6 on cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const input = join(dir, 'cycle.jsonl');
  writeFileSync(input, [
    '{"type":"charge","batch":"A"}',
    '{"type":"mix","inputs":["A"],"output":"B"}',
    '{"type":"link","from":"B","to":"A"}',
    '',
  ].join('\n'));
  const r = run(['build', input, '--state', join(dir, 's.json')], dir);
  assert.equal(r.status, 6);
  assert.match(r.stderr, /cycle/i);
});

test('CLI build exits 7 on unknown batch reference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const input = join(dir, 'bad.jsonl');
  writeFileSync(input, '{"type":"mix","inputs":["GHOST"],"output":"B"}\n');
  const r = run(['build', input, '--state', join(dir, 's.json')], dir);
  assert.equal(r.status, 7);
  assert.match(r.stderr, /unknown batch/i);
});

test('CLI correct exits 7 on unknown batch', () => {
  const { dir, input } = fixture();
  const state = join(dir, 'state.json');
  run(['build', input, '--state', state], dir);
  const r = run(['correct', '--state', state, '--batch', 'NOPE', '--status', 'pass'], dir);
  assert.equal(r.status, 7);
});

test('CLI build --append extends an existing state (post-scrap split stays clean)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  const base = join(dir, 'base.jsonl');
  writeFileSync(base, [
    '{"type":"charge","batch":"X"}',
    '{"type":"inspect","id":"I1","batch":"X","status":"fail"}',
    '{"type":"scrap","batch":"X"}',
    '',
  ].join('\n'));
  const state = join(dir, 'state.json');
  assert.equal(run(['build', base, '--state', state], dir).status, 0);

  const extra = join(dir, 'extra.jsonl');
  writeFileSync(extra, '{"type":"split","input":"X","outputs":["Z"]}\n');
  assert.equal(run(['build', extra, '--state', state, '--append', state], dir).status, 0);

  const r = run(['recall', '--state', state], dir);
  const cert = JSON.parse(r.stdout);
  assert.deepEqual(cert.contaminated, ['X']);
  assert.deepEqual(cert.boundary.affectedProducts, []);
});
