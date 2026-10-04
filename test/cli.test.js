'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli');

const H = 3600 * 1000;
const iso = (h) => new Date(h * H).toISOString();

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oee-cli-'));
}

function writeJson(dir, name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
  return p;
}

function runCli(args) {
  const captured = { stdout: '', stderr: '' };
  const status = run(['node', 'src/cli.js', ...args], {
    stdout: (s) => {
      captured.stdout += s;
    },
    stderr: (s) => {
      captured.stderr += s;
    },
  });
  return { status, ...captured };
}

test('CLI happy path: exit 0, writes sessions/shifts/diff/version', () => {
  const dir = makeTmpDir();
  const events = writeJson(dir, 'events.json', {
    shift: { anchor: iso(0), lengthHours: 8 },
    intervals: [
      { id: 'e1', device: 'press-1', start: iso(0), end: iso(4), state: 'RUN' },
      { id: 'e2', device: 'press-1', start: iso(4), end: iso(6), state: 'FAIL' },
    ],
  });
  const commands = writeJson(dir, 'commands.json', [
    { op: 'append', interval: { id: 'e3', device: 'press-1', start: iso(6), end: iso(9), state: 'RUN' } },
    { op: 'correct', id: 'e2', interval: { end: iso(5), state: 'IDLE' } },
    { op: 'delete', id: 'e3' },
    { op: 'undo' },
    { op: 'redo' },
  ]);
  const out = path.join(dir, 'out.json');
  const res = runCli(['oee', events, commands, '-o', out]);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stderr, '');
  const summary = JSON.parse(res.stdout);
  assert.equal(summary.ok, true);
  assert.match(summary.version, /^[0-9a-f]{64}$/);

  const result = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.version, summary.version);
  assert.ok(Array.isArray(result.sessions));
  assert.ok(Array.isArray(result.shifts));
  assert.equal(result.diff.length, 5);
  assert.deepEqual(
    result.diff.map((d) => d.op),
    ['append', 'correct', 'delete', 'undo', 'redo']
  );

  const shift0 = result.shifts.find((s) => s.device === 'press-1' && s.shiftIndex === 0);
  assert.equal(shift0.runMs, 4 * H);
  assert.equal(shift0.idleMs, 1 * H);
  assert.equal(shift0.failMs, 0);
  assert.equal(shift0.availability, 4 / 5);

  const runSession = result.sessions.find((s) => s.state === 'RUN');
  assert.equal(runSession.durationMs, 4 * H);
});

test('CLI is deterministic: identical inputs produce identical version hash', () => {
  const dir = makeTmpDir();
  const events = writeJson(dir, 'events.json', {
    intervals: [{ id: 'e1', device: 'd', start: iso(0), end: iso(2), state: 'RUN' }],
  });
  const commands = writeJson(dir, 'commands.json', [
    { op: 'append', interval: { id: 'e2', device: 'd', start: iso(2), end: iso(3), state: 'RUN' } },
  ]);
  const out1 = path.join(dir, 'out1.json');
  const out2 = path.join(dir, 'out2.json');
  assert.equal(runCli(['oee', events, commands, '-o', out1]).status, 0);
  assert.equal(runCli(['oee', events, commands, '-o', out2]).status, 0);
  const r1 = JSON.parse(fs.readFileSync(out1, 'utf8'));
  const r2 = JSON.parse(fs.readFileSync(out2, 'utf8'));
  assert.equal(r1.version, r2.version);
  assert.deepEqual(r1, r2);
});

test('CLI missing events file: exit 1 with structured FILE_ERROR', () => {
  const dir = makeTmpDir();
  const commands = writeJson(dir, 'commands.json', []);
  const res = runCli(['oee', path.join(dir, 'nope.json'), commands, '-o', path.join(dir, 'o.json')]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  const err = JSON.parse(res.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'FILE_ERROR');
  assert.ok(err.error.message.includes('nope.json'));
});

test('CLI malformed JSON: exit 1 with structured JSON_ERROR', () => {
  const dir = makeTmpDir();
  const events = path.join(dir, 'events.json');
  fs.writeFileSync(events, '{ not json');
  const commands = writeJson(dir, 'commands.json', []);
  const res = runCli(['oee', events, commands, '-o', path.join(dir, 'o.json')]);
  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'JSON_ERROR');
});

test('CLI overlap in commands: exit 1 with structured OVERLAP error and command index', () => {
  const dir = makeTmpDir();
  const events = writeJson(dir, 'events.json', {
    intervals: [{ id: 'e1', device: 'd', start: iso(0), end: iso(4), state: 'RUN' }],
  });
  const commands = writeJson(dir, 'commands.json', [
    { op: 'append', interval: { id: 'e2', device: 'd', start: iso(2), end: iso(6), state: 'IDLE' } },
  ]);
  const out = path.join(dir, 'o.json');
  const res = runCli(['oee', events, commands, '-o', out]);
  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.ok, false);
  assert.equal(err.error.code, 'OVERLAP');
  assert.equal(err.error.details.commandIndex, 0);
  assert.equal(fs.existsSync(out), false, 'no output file on failure');
});

test('CLI unknown state in events: exit 1 with structured UNKNOWN_STATE error', () => {
  const dir = makeTmpDir();
  const events = writeJson(dir, 'events.json', {
    intervals: [{ id: 'e1', device: 'd', start: iso(0), end: iso(4), state: 'SLEEP' }],
  });
  const commands = writeJson(dir, 'commands.json', []);
  const res = runCli(['oee', events, commands, '-o', path.join(dir, 'o.json')]);
  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'UNKNOWN_STATE');
});

test('CLI backward clock in events: exit 1 with structured BACKWARD_CLOCK error', () => {
  const dir = makeTmpDir();
  const events = writeJson(dir, 'events.json', {
    intervals: [{ id: 'e1', device: 'd', start: iso(4), end: iso(4), state: 'RUN' }],
  });
  const commands = writeJson(dir, 'commands.json', []);
  const res = runCli(['oee', events, commands, '-o', path.join(dir, 'o.json')]);
  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'BACKWARD_CLOCK');
});

test('CLI usage error: exit 1 with structured USAGE error', () => {
  const res = runCli(['oee', 'only-one.json']);
  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'USAGE');
});
