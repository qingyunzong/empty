'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, applyEvent, computeHash } = require('../src/biobank');

const BIN = path.join(__dirname, '..', 'bin', 'biobank.js');

const CONFIG = JSON.stringify({
  type: 'config',
  racks: [{ id: 'R1', zone: '-80', capacity: 2 }],
  quotas: { P1: 1 },
});

// NOTE: this sandboxed environment loses piped stdout/stderr of spawned
// children, so the CLI is run through a shell that redirects to files.
function runCli(input, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biobank-'));
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, input);
  const out = path.join(dir, 'out.txt');
  const err = path.join(dir, 'err.txt');
  const code = path.join(dir, 'code.txt');
  const cmd = [
    process.execPath, JSON.stringify(BIN), JSON.stringify(file),
    ...extraArgs.map((a) => JSON.stringify(a)),
    '>', JSON.stringify(out), '2>', JSON.stringify(err), ';', 'echo', '$?', '>', JSON.stringify(code),
  ].join(' ');
  spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8' });
  const result = {
    status: Number(fs.readFileSync(code, 'utf8').trim()),
    stdout: fs.readFileSync(out, 'utf8'),
    stderr: fs.readFileSync(err, 'utf8'),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

test('illegal event: stderr JSON and exit 2', () => {
  const input = [CONFIG, '{"type":"arrive","id":"A","project":"P1","zone":"-80","arrival":0,"deadline":9}'].join('\n');
  const r = runCli(input);
  assert.equal(r.status, 2);
  const err = JSON.parse(r.stderr.trim());
  assert.equal(err.error, 'illegal_event');
  assert.equal(typeof err.line, 'number');
});

test('capacity overflow: invalid rack capacity rejected with exit 2', () => {
  const bad = JSON.stringify({ type: 'config', racks: [{ id: 'R1', zone: '-80', capacity: 0 }] });
  const r = runCli(bad + '\n');
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr.trim()).error, 'capacity_overflow');

  const badQuota = JSON.stringify({
    type: 'config',
    racks: [{ id: 'R1', zone: '-80', capacity: 1 }],
    quotas: { P1: -1 },
  });
  const r2 = runCli(badQuota + '\n');
  assert.equal(r2.status, 2);
  assert.equal(JSON.parse(r2.stderr.trim()).error, 'capacity_overflow');
});

test('time regression: stderr JSON and exit 2', () => {
  const input = [
    CONFIG,
    '{"type":"arrive","id":"A","project":"P1","priority":1,"zone":"-80","arrival":5,"deadline":9}',
    '{"type":"arrive","id":"B","project":"P1","priority":1,"zone":"-80","arrival":3,"deadline":9}',
  ].join('\n');
  const r = runCli(input);
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr.trim()).error, 'time_regression');
});

test('failed event does not change state', () => {
  const store = createStore(JSON.parse(CONFIG));
  applyEvent(store, { type: 'arrive', id: 'A', project: 'P1', priority: 1, zone: '-80', arrival: 0, deadline: 9 });
  const before = computeHash(store);
  const badEvents = [
    { type: 'arrive', id: 'A', project: 'P1', priority: 1, zone: '-80', arrival: 1, deadline: 9 }, // duplicate id
    { type: 'cancel', id: 'A', time: 1 }, // A is placed, not waiting
    { type: 'undo', to: 99, time: 1 },
    { type: 'bogus', time: 1 },
    { type: 'arrive', id: 'C', project: 'P1', priority: 1, zone: '-80', arrival: 1 }, // missing deadline
    { type: 'arrive', id: 'D', project: 'P1', priority: 1, zone: '-80', arrival: -1, deadline: 9 }, // negative time
  ];
  for (const ev of badEvents) {
    const hashBefore = computeHash(store);
    assert.throws(() => applyEvent(store, ev), (e) => e.code === 'illegal_event' || e.code === 'time_regression');
    assert.equal(computeHash(store), hashBefore, 'state unchanged after rejected event');
  }
  assert.equal(computeHash(store), before);
});

test('malformed JSON line is an illegal event with exit 2', () => {
  const r = runCli(CONFIG + '\n{"type":"arrive",oops\n');
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stderr.trim()).error, 'illegal_event');
});

test('valid run exits 0 and emits one JSON step per event', () => {
  const input = [
    CONFIG,
    '{"type":"arrive","id":"A","project":"P1","priority":1,"zone":"-80","arrival":0,"deadline":9}',
    '{"type":"arrive","id":"B","project":"P1","priority":1,"zone":"-80","arrival":1,"deadline":9}',
  ].join('\n');
  const r = runCli(input);
  assert.equal(r.status, 0);
  const steps = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(steps.length, 2);
  assert.equal(steps[0].placements[0].id, 'A');
  assert.equal(steps[1].waiting[0].reason, 'quota_exceeded');
  assert.match(steps[1].hash, /^[0-9a-f]{64}$/);
});
