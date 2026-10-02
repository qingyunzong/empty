import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.js';

function runCli(args) {
  const io = {
    stdout: (s) => {
      io.out += s;
    },
    stderr: (s) => {
      io.err += s;
    },
    out: '',
    err: '',
  };
  const code = run(args, io);
  return { code, stdout: io.out, stderr: io.err };
}

function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

const feasibleProblem = {
  slots: 3,
  machines: ['M1', 'M2'],
  tools: { T1: { life: 12 } },
  fixtures: ['F1'],
  ops: [
    { id: 'A', machines: ['M1', 'M2'], tools: ['T1'], cut: 4, fixture: 'F1', due: 0 },
    { id: 'B', machines: ['M1'], tools: ['T1'], cut: 4, fixture: null, due: 1 },
  ],
};

test('CLI schedule: feasible problem exits 0 with optimal assignment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problemPath = writeJson(dir, 'problem.json', feasibleProblem);
  const res = runCli(['schedule', problemPath]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'optimal');
  assert.ok(out.assignment.A && out.assignment.B);
});

test('CLI schedule: infeasible problem exits 1 with proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problem = { ...feasibleProblem, tools: { T1: { life: 7 } } };
  const problemPath = writeJson(dir, 'problem.json', problem);
  const res = runCli(['schedule', problemPath]);
  assert.equal(res.code, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'infeasible');
  assert.equal(out.proof.type, 'tool-life');
  assert.equal(out.proof.tool, 'T1');
});

test('CLI schedule: budget exhaustion exits 3 with unknown and pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problemPath = writeJson(dir, 'problem.json', feasibleProblem);
  const res = runCli(['schedule', problemPath, '--budget', '0']);
  assert.equal(res.code, 3, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'unknown');
  assert.ok(out.pending.length > 0);
});

test('CLI schedule: non-integer cut exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problem = JSON.parse(JSON.stringify(feasibleProblem));
  problem.ops[0].cut = 2.5;
  const problemPath = writeJson(dir, 'problem.json', problem);
  const res = runCli(['schedule', problemPath]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /integer/);
});

test('CLI schedule: unknown tool exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problem = JSON.parse(JSON.stringify(feasibleProblem));
  problem.ops[0].tools = ['NOPE'];
  const problemPath = writeJson(dir, 'problem.json', problem);
  const res = runCli(['schedule', problemPath]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown tool 'NOPE'/);
});

test('CLI schedule: non-integer budget exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problemPath = writeJson(dir, 'problem.json', feasibleProblem);
  const res = runCli(['schedule', problemPath, '--budget', 'abc']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /budget/);
});

test('CLI replace: applies replacement and keeps other assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const problemPath = writeJson(dir, 'problem.json', feasibleProblem);
  const scheduled = runCli(['schedule', problemPath]);
  assert.equal(scheduled.code, 0, scheduled.stderr);
  const assignment = JSON.parse(scheduled.stdout).assignment;

  const spec = {
    problem: feasibleProblem,
    assignment,
    op: 'B',
    newOp: { id: 'B', machines: ['M1', 'M2'], tools: ['T1'], cut: 6, fixture: null, due: 1 },
  };
  const specPath = writeJson(dir, 'replace.json', spec);
  const res = runCli(['replace', specPath]);
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.assignment.A, assignment.A, 'op A assignment unchanged');
  assert.equal(out.assignment.B.tool, 'T1');
});

test('CLI replace: unknown tool in newOp exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const spec = {
    problem: feasibleProblem,
    assignment: {
      A: { machine: 'M1', slot: 0, tool: 'T1' },
      B: { machine: 'M1', slot: 1, tool: 'T1' },
    },
    op: 'B',
    newOp: { id: 'B', machines: ['M1'], tools: ['GHOST'], cut: 2, fixture: null, due: 1 },
  };
  const specPath = writeJson(dir, 'replace.json', spec);
  const res = runCli(['replace', specPath]);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /unknown tool 'GHOST'/);
});

test('CLI replace: over-life replacement exits 1 with tool-life proof', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mach-sched-'));
  const spec = {
    problem: feasibleProblem,
    assignment: {
      A: { machine: 'M1', slot: 0, tool: 'T1' },
      B: { machine: 'M1', slot: 1, tool: 'T1' },
    },
    op: 'B',
    newOp: { id: 'B', machines: ['M1'], tools: ['T1'], cut: 9, fixture: null, due: 1 },
  };
  const specPath = writeJson(dir, 'replace.json', spec);
  const res = runCli(['replace', specPath]);
  assert.equal(res.code, 1, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.status, 'infeasible');
  assert.ok(out.proof.some((r) => r.type === 'tool-life' && r.tool === 'T1'));
});
