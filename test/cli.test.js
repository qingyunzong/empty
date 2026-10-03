'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'index.js');

function setupDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merge-orders-'));
}

function writeJson(dir, name, value) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function runCli(args, dir) {
  const errFile = path.join(dir, 'stderr-capture.txt');
  const fd = fs.openSync(errFile, 'w');
  const res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', 'ignore', fd] });
  fs.closeSync(fd);
  return { status: res.status, stderr: fs.readFileSync(errFile, 'utf8') };
}

const BASE = [
  { id: 'o1', status: 'assigned', assignee: 'alice', priority: 'low' },
];

test('CLI merge-orders succeeds and writes the merged result with exit code 0', () => {
  const dir = setupDir();
  const base = writeJson(dir, 'base.json', BASE);
  const local = writeJson(dir, 'local.json', [
    { id: 'o1', status: 'assigned', assignee: 'bob', priority: 'low' },
  ]);
  const remote = writeJson(dir, 'remote.json', [
    { id: 'o1', status: 'assigned', assignee: 'alice', priority: 'high' },
  ]);
  const out = path.join(dir, 'r.json');
  const res = runCli(['merge-orders', '--base', base, '--local', local, '--remote', remote, '--out', out], dir);
  assert.equal(res.status, 0, res.stderr);
  const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(merged.o1.assignee, 'bob');
  assert.equal(merged.o1.priority, 'high');
});

test('CLI exits 1 on merge conflict and reports conflicts on stderr', () => {
  const dir = setupDir();
  const base = writeJson(dir, 'base.json', BASE);
  const local = writeJson(dir, 'local.json', [
    { id: 'o1', status: 'assigned', assignee: 'bob', priority: 'low' },
  ]);
  const remote = writeJson(dir, 'remote.json', [
    { id: 'o1', status: 'assigned', assignee: 'dave', priority: 'low' },
  ]);
  const out = path.join(dir, 'r.json');
  const res = runCli(['merge-orders', '--base', base, '--local', local, '--remote', remote, '--out', out], dir);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stderr);
  assert.ok(report.conflicts.some((c) => c.orderId === 'o1' && c.field === 'assignee'));
  assert.equal(fs.existsSync(out), false);
});

test('CLI exits 1 when a side modifies a terminal order', () => {
  const dir = setupDir();
  const base = writeJson(dir, 'base.json', [
    { id: 'o1', status: 'done', assignee: 'alice', priority: 'high' },
  ]);
  const local = writeJson(dir, 'local.json', [
    { id: 'o1', status: 'in_progress', assignee: 'alice', priority: 'high' },
  ]);
  const remote = writeJson(dir, 'remote.json', [
    { id: 'o1', status: 'done', assignee: 'bob', priority: 'high' },
  ]);
  const out = path.join(dir, 'r.json');
  const res = runCli(['merge-orders', '--base', base, '--local', local, '--remote', remote, '--out', out], dir);
  assert.equal(res.status, 1);
});

test('CLI exits 2 for invalid order data, unknown command and missing files', () => {
  const dir = setupDir();
  const bad = writeJson(dir, 'bad.json', [
    { id: 'o1', status: 'bogus', assignee: 'alice', priority: 'low' },
  ]);
  const good = writeJson(dir, 'good.json', BASE);
  const out = path.join(dir, 'r.json');

  let res = runCli(['merge-orders', '--base', bad, '--local', good, '--remote', good, '--out', out], dir);
  assert.equal(res.status, 2);

  res = runCli(['frobnicate', '--base', good, '--local', good, '--remote', good, '--out', out], dir);
  assert.equal(res.status, 2);

  res = runCli(['merge-orders', '--base', path.join(dir, 'missing.json'), '--local', good, '--remote', good, '--out', out], dir);
  assert.equal(res.status, 2);

  res = runCli(['merge-orders', '--base', good, '--local', good], dir);
  assert.equal(res.status, 2);
});
