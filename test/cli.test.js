import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';

// Runs the CLI in-process (the sandbox forbids spawning child processes);
// runCli returns exactly the exit code the real process would use.
function run(args) {
  const out = [];
  const err = [];
  const code = runCli(args, {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function writeJson(dir, name, obj) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

const validInstance = {
  machines: ['M1'],
  tools: [{ id: 'T1', life: 100 }],
  fixtures: [],
  horizon: 10,
  slotMinutes: 1,
  operations: [{ id: 'a', machines: ['M1'], minutes: 5, tools: ['T1'] }],
};

test('schedule prints an optimal plan as JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mps-'));
  const file = writeJson(dir, 'ok.json', validInstance);
  const res = run(['schedule', file]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'optimal');
  assert.equal(out.assignments.a.tool, 'T1');
});

test('replace command schedules then replaces an operation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mps-'));
  const file = writeJson(dir, 'ok.json', validInstance);
  const newOp = writeJson(dir, 'new.json', {
    id: 'b',
    machines: ['M1'],
    minutes: 3,
    tools: ['T1'],
  });
  const res = run(['replace', file, '--op', 'a', '--with', newOp]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'optimal');
  assert.equal(out.assignments.a, undefined);
  assert.equal(out.assignments.b.tool, 'T1');
  assert.equal(out.toolLoad.T1, 3);
});

test('non-integer field exits with code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mps-'));
  const file = writeJson(dir, 'bad.json', {
    ...validInstance,
    operations: [{ ...validInstance.operations[0], minutes: 5.5 }],
  });
  const res = run(['schedule', file]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /minutes must be a positive integer/);
});

test('non-integer --budget exits with code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mps-'));
  const file = writeJson(dir, 'ok.json', validInstance);
  const res = run(['schedule', file, '--budget', 'abc']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--budget must be an integer/);
});

test('unknown tool exits with code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mps-'));
  const file = writeJson(dir, 'bad.json', {
    ...validInstance,
    operations: [{ ...validInstance.operations[0], tools: ['T9'] }],
  });
  const res = run(['schedule', file]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown tool "T9"/);
});

test('unknown tool in replacement op exits with code 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mps-'));
  const file = writeJson(dir, 'ok.json', validInstance);
  const newOp = writeJson(dir, 'new.json', {
    id: 'b',
    machines: ['M1'],
    minutes: 3,
    tools: ['T9'],
  });
  const res = run(['replace', file, '--op', 'a', '--with', newOp]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown tool "T9"/);
});
