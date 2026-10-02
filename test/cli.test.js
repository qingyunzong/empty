'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../src/cli.js');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oee-cli-'));
}

function writeJson(dir, name, value) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value));
  return p;
}

function runCli(args) {
  const out = { stdout: '', stderr: '' };
  const status = run(['node', CLI, ...args], {
    stdout: (s) => { out.stdout += s; },
    stderr: (s) => { out.stderr += s; },
  });
  return { status, stdout: out.stdout, stderr: out.stderr };
}

const EVENTS = {
  shifts: [
    { id: 'S1', start: '2026-01-01T00:00:00Z', end: '2026-01-01T08:00:00Z' },
    { id: 'S2', start: '2026-01-01T08:00:00Z', end: '2026-01-01T16:00:00Z' },
  ],
  events: [
    { id: 'a', start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', state: 'RUN' },
    { id: 'b', start: '2026-01-01T02:00:00Z', end: '2026-01-01T03:00:00Z', state: 'RUN' },
    { id: 'c', start: '2026-01-01T03:00:00Z', end: '2026-01-01T04:00:00Z', state: 'FAIL' },
  ],
};

test('CLI success: exit 0, writes sessions/shift metrics/diffs/version hash', () => {
  const dir = tmpdir();
  const eventsPath = writeJson(dir, 'events.json', EVENTS);
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'append', event: { id: 'd', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z', state: 'RUN' } },
    { op: 'correct', id: 'c', event: { start: '2026-01-01T03:00:00Z', end: '2026-01-01T09:00:00Z', state: 'FAIL' } },
    { op: 'undo' },
    { op: 'redo' },
    { op: 'delete', id: 'd' },
  ]);
  const outPath = path.join(dir, 'out.json');
  const res = runCli(['oee', eventsPath, commandsPath, '-o', outPath]);

  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.equal(res.stderr, '');
  const ack = JSON.parse(res.stdout);
  assert.equal(ack.ok, true);

  const out = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.match(out.version, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    out.sessions.map((s) => [s.state, s.start, s.end]),
    [
      ['RUN', '2026-01-01T01:00:00.000Z', '2026-01-01T03:00:00.000Z'],
      ['FAIL', '2026-01-01T03:00:00.000Z', '2026-01-01T09:00:00.000Z'],
    ],
  );
  const s1 = out.shifts.find((s) => s.id === 'S1');
  const s2 = out.shifts.find((s) => s.id === 'S2');
  assert.equal(s1.runMs, 2 * 3600 * 1000);
  assert.equal(s1.failMs, 5 * 3600 * 1000);
  assert.equal(s2.failMs, 1 * 3600 * 1000);
  assert.equal(s2.availability, 0);
  assert.equal(out.diffs.length, 5);
  assert.deepEqual(out.diffs.map((d) => d.op), ['append', 'correct', 'undo', 'redo', 'delete']);

  // deterministic: same inputs produce the same version hash
  const out2 = path.join(dir, 'out2.json');
  const res2 = runCli(['oee', eventsPath, commandsPath, '-o', out2]);
  assert.equal(res2.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(out2, 'utf8')).version, out.version);
});

test('CLI rejects overlapping intervals with exit 1 and structured error', () => {
  const dir = tmpdir();
  const eventsPath = writeJson(dir, 'events.json', {
    events: [
      { id: 'a', start: '2026-01-01T01:00:00Z', end: '2026-01-01T03:00:00Z', state: 'RUN' },
      { id: 'b', start: '2026-01-01T02:00:00Z', end: '2026-01-01T04:00:00Z', state: 'IDLE' },
    ],
  });
  const commandsPath = writeJson(dir, 'commands.json', []);
  const res = runCli(['oee', eventsPath, commandsPath, '-o', path.join(dir, 'out.json')]);

  assert.equal(res.status, 1);
  const err = JSON.parse(res.stderr);
  assert.equal(err.error.code, 'OVERLAP');
  assert.ok(fs.existsSync(path.join(dir, 'out.json')) === false);
});

test('CLI rejects unknown state with exit 1 and structured error', () => {
  const dir = tmpdir();
  const eventsPath = writeJson(dir, 'events.json', {
    events: [{ id: 'a', start: '2026-01-01T01:00:00Z', end: '2026-01-01T02:00:00Z', state: 'FLYING' }],
  });
  const commandsPath = writeJson(dir, 'commands.json', []);
  const res = runCli(['oee', eventsPath, commandsPath, '-o', path.join(dir, 'out.json')]);

  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'UNKNOWN_STATE');
});

test('CLI rejects backward clock via command with exit 1', () => {
  const dir = tmpdir();
  const eventsPath = writeJson(dir, 'events.json', { events: [] });
  const commandsPath = writeJson(dir, 'commands.json', [
    { op: 'append', event: { id: 'x', start: '2026-01-01T05:00:00Z', end: '2026-01-01T04:00:00Z', state: 'RUN' } },
  ]);
  const res = runCli(['oee', eventsPath, commandsPath, '-o', path.join(dir, 'out.json')]);

  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'BACKWARD_CLOCK');
});

test('CLI: missing file and malformed JSON exit 1 with structured errors', () => {
  const dir = tmpdir();
  const commandsPath = writeJson(dir, 'commands.json', []);

  const missing = runCli(['oee', path.join(dir, 'nope.json'), commandsPath, '-o', path.join(dir, 'o.json')]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'FILE_NOT_FOUND');

  const badPath = writeJson(dir, 'bad.json', '{ not json');
  const bad = runCli(['oee', badPath, commandsPath, '-o', path.join(dir, 'o.json')]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, 'INVALID_JSON');

  const noArgs = runCli([]);
  assert.equal(noArgs.status, 1);
  assert.equal(JSON.parse(noArgs.stderr).error.code, 'INVALID_ARGS');
});
