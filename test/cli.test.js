'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLAN = path.join(__dirname, '..', 'plan.js');
const SMALL = path.join(__dirname, '..', 'examples', 'small.json');

// NOTE: this sandbox swallows pipe captures of grandchild processes, so the
// child's stdout/stderr are redirected to real files and read back.
function runPlan(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
  const outFile = path.join(dir, 'stdout.txt');
  const errFile = path.join(dir, 'stderr.txt');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  const r = spawnSync(process.execPath, [PLAN, ...args], {
    stdio: ['ignore', outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  return {
    status: r.status,
    stdout: fs.readFileSync(outFile, 'utf8'),
    stderr: fs.readFileSync(errFile, 'utf8'),
  };
}

function writeTmp(model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
  const file = path.join(dir, 'input.json');
  fs.writeFileSync(file, JSON.stringify(model));
  return file;
}

const validModel = {
  inspectors: [{ id: 'amy', skills: ['electrical'] }],
  tasks: [
    { id: 't1', skills: ['electrical'], duration: 2, window: { start: 0, end: 5 }, zone: 'Z1' },
  ],
  travel: { Z1: { Z2: 1 } },
};

test('plan input.json --budget 500 prints an optimal plan and exits 0', () => {
  const r = runPlan([SMALL, '--budget', '500']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'optimal');
  assert.equal(out.makespan, 4);
  assert.equal(out.totalTravel, 1);
  assert.equal(out.assignments.length, 4);
});

test('missing skills field exits 2', () => {
  const bad = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [{ id: 't1', duration: 2, window: { start: 0, end: 5 }, zone: 'Z1' }],
  };
  const r = runPlan([writeTmp(bad)]);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /missing skills/);
});

test('empty skills array on a task exits 2', () => {
  const bad = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [{ id: 't1', skills: [], duration: 2, window: { start: 0, end: 5 }, zone: 'Z1' }],
  };
  const r = runPlan([writeTmp(bad)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing skills/);
});

test('negative travel time exits 2', () => {
  const bad = { ...validModel, travel: { Z1: { Z2: -3 } } };
  const r = runPlan([writeTmp(bad)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must not be negative/);
});

test('illegal window (end before start) exits 2', () => {
  const bad = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [{ id: 't1', skills: ['electrical'], duration: 1, window: { start: 5, end: 2 }, zone: 'Z1' }],
  };
  const r = runPlan([writeTmp(bad)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /illegal window/);
});

test('non-integer window bound exits 2', () => {
  const bad = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [{ id: 't1', skills: ['electrical'], duration: 1, window: { start: 0.5, end: 4 }, zone: 'Z1' }],
  };
  const r = runPlan([writeTmp(bad)]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /illegal window/);
});

test('infeasible skill requirement exits 1 with a conflict proof', () => {
  const model = {
    inspectors: [{ id: 'amy', skills: ['electrical'] }],
    tasks: [
      { id: 't9', skills: ['thermal-imaging'], duration: 1, window: { start: 0, end: 4 }, zone: 'Z1' },
    ],
  };
  const r = runPlan([writeTmp(model)]);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'infeasible');
  assert.equal(out.conflict.type, 'skill');
  assert.equal(out.conflict.task, 't9');
});

test('budget exhaustion exits 3 and lists pending tasks', () => {
  const r = runPlan([SMALL, '--budget', '0']);
  assert.equal(r.status, 3, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'unknown');
  assert.ok(out.pending.length > 0);
});

test('missing input file exits 2', () => {
  const r = runPlan(['/nonexistent/input.json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read/);
});

test('malformed JSON exits 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ not json');
  const r = runPlan([file]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid JSON/);
});
