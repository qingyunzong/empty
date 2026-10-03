'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require("node:child_process");
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trace-cli-'));
}

function runCli(args) {
  // Capture via files instead of pipes: robust in sandboxes that swallow
  // grandchild stdout pipes, and equivalent to pipes everywhere else.
  const dir = tmpdir();
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const proc = spawnSync(process.execPath, [CLI, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: proc.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

test('cli trace: full scenario with queries, diffs and certificates', () => {
  const dir = tmpdir();
  const events = [
    { op: 'define', batch: 'A', kind: 'input' },
    { op: 'define', batch: 'B', kind: 'input' },
    { op: 'define', batch: 'P', kind: 'output' },
    { op: 'define', batch: 'Q', kind: 'output' },
    { op: 'transform', output: 'P', inputs: ['A'] },
    { op: 'transform', output: 'Q', inputs: ['P', 'B'] },
    { op: 'hold', batch: 'A' },
    { op: 'query', batch: 'Q' },
    { op: 'correct', index: 4, event: { op: 'transform', output: 'P', inputs: ['B'] } },
    { op: 'query', batch: 'Q' },
    { op: 'undo' },
    { op: 'query', batch: 'Q' },
  ];
  const eventsFile = path.join(dir, 'events.json');
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(eventsFile, JSON.stringify(events));

  const proc = runCli(['trace', eventsFile, '-o', resultFile]);
  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /trace ok/);

  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.queries.length, 3);

  const [held, corrected, restored] = result.queries.map((q) => q.certificate);
  assert.equal(held.status, 'held');
  assert.deepEqual(held.paths, [['A', 'P', 'Q']]);
  assert.equal(corrected.status, 'released');
  assert.deepEqual(corrected.blockReasons, []);
  assert.equal(restored.status, 'held');
  assert.deepEqual(restored.paths, [['A', 'P', 'Q']]);

  const correctDiff = result.versions.find((v) => v.op === 'correct').diff;
  assert.deepEqual(correctDiff.edges.removed, [{ output: 'P', input: 'A' }]);
  assert.deepEqual(correctDiff.edges.added, [{ output: 'P', input: 'B' }]);
});

test('cli trace: unknown parent fails with exit code 1 and error record', () => {
  const dir = tmpdir();
  const events = [
    { op: 'define', batch: 'P', kind: 'output' },
    { op: 'transform', output: 'P', inputs: ['GHOST'] },
    { op: 'query', batch: 'P' },
  ];
  const eventsFile = path.join(dir, 'events.json');
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(eventsFile, JSON.stringify(events));

  const proc = runCli(['trace', eventsFile, '-o', resultFile]);
  assert.equal(proc.status, 1);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'UNKNOWN_BATCH');
  assert.equal(result.errors[0].opIndex, 1);
  assert.equal(result.queries.length, 0);
});

test('cli trace: cycle and duplicate output are reported as errors', () => {
  const dir = tmpdir();
  const events = [
    { op: 'define', batch: 'P', kind: 'output' },
    { op: 'define', batch: 'Q', kind: 'output' },
    { op: 'transform', output: 'P', inputs: ['Q'] },
    { op: 'transform', output: 'Q', inputs: ['P'] },
  ];
  const eventsFile = path.join(dir, 'events.json');
  const resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(eventsFile, JSON.stringify(events));
  const proc = runCli(['trace', eventsFile, '-o', resultFile]);
  assert.equal(proc.status, 1);
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result.errors[0].code, 'CYCLE');

  const dupEvents = [
    { op: 'define', batch: 'A', kind: 'input' },
    { op: 'define', batch: 'P', kind: 'output' },
    { op: 'transform', output: 'P', inputs: ['A'] },
    { op: 'transform', output: 'P', inputs: ['A'] },
  ];
  fs.writeFileSync(eventsFile, JSON.stringify(dupEvents));
  const proc2 = runCli(['trace', eventsFile, '-o', resultFile]);
  assert.equal(proc2.status, 1);
  const result2 = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  assert.equal(result2.errors[0].code, 'DUPLICATE_OUTPUT');
});

test('cli: deterministic output across runs', () => {
  const dir = tmpdir();
  const eventsFile = path.join(__dirname, '..', 'examples', 'events.json');
  const out1 = path.join(dir, 'r1.json');
  const out2 = path.join(dir, 'r2.json');
  assert.equal(runCli(['trace', eventsFile, '-o', out1]).status, 0);
  assert.equal(runCli(['trace', eventsFile, '-o', out2]).status, 0);
  assert.equal(fs.readFileSync(out1, 'utf8'), fs.readFileSync(out2, 'utf8'));
});

test('cli: usage errors exit with code 2', () => {
  const proc = runCli(['bogus']);
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /unknown command/);
  const missing = runCli(['trace', '/nonexistent/events.json']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read\/parse/);
});
