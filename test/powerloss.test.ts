import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CrashPoint, Executor, StageDef } from '../src/index.js';

// Power loss is simulated in-process: the injected crash hook throws an
// error that bypasses all executor cleanup/failure handling (exactly like an
// abrupt process death — the sandbox forbids spawning real child processes),
// and a brand-new Executor instance over the same cache dir plays the reboot.

class SimulatedPowerLoss extends Error {
  constructor() {
    super('power cut');
    this.name = 'SimulatedPowerLoss';
  }
}

const crash = (): never => {
  throw new SimulatedPowerLoss();
};

interface Rig {
  stateDir: string;
  cacheDir: string;
  inputFile: string;
  makeExecutor: (crashAt?: CrashPoint) => Executor;
  executions: () => string[];
}

function rig(): Rig {
  const stateDir = mkdtempSync(join(tmpdir(), 'orch-power-'));
  const cacheDir = join(stateDir, 'cache');
  const inputFile = join(stateDir, 'input.txt');
  const logPath = join(stateDir, 'executions.log');
  writeFileSync(inputFile, 'v1');

  // Linear pipeline A -> B -> C -> D; B depends on the input file's content.
  const stage = (id: string, deps: string[] = [], inputs: string[] = []): StageDef => ({
    id,
    deps,
    inputs,
    run: (ctx) => {
      appendFileSync(logPath, `executed ${id}\n`);
      // Output propagates dependency outputs and file content, so a change
      // upstream genuinely alters everything downstream.
      const upstream = deps.map((dep) => String(ctx.deps[dep])).join('|');
      const file = inputs.length > 0 ? `:${ctx.inputs[inputs[0]!]}` : '';
      return `${id}[${upstream}]${file}`;
    },
  });
  const stages = (): StageDef[] => [
    stage('A'),
    stage('B', ['A'], [inputFile]),
    stage('C', ['B']),
    stage('D', ['C']),
  ];

  return {
    stateDir,
    cacheDir,
    inputFile,
    makeExecutor: (crashAt?: CrashPoint) =>
      new Executor(stages(), { cacheDir, hooks: { crashAt, crash } }),
    executions: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.startsWith('executed '))
        .map((line) => line.split(' ')[1]!),
  };
}

const count = (lines: string[], id: string): number => lines.filter((l) => l === id).length;

test('power loss after a committed publish reuses it and resumes successors', async () => {
  const r = rig();

  // Die right after B's record is atomically committed.
  await rejects(() => r.makeExecutor({ stageId: 'B', phase: 'after-publish' }).run(), (err) => err instanceof SimulatedPowerLoss);
  deepEqual(r.executions(), ['A', 'B']);

  // Power back on: A and B must be reused, only C and D execute.
  const report = await r.makeExecutor().run();
  equal(report.ok, true);
  deepEqual(report.stages, { A: 'reused', B: 'reused', C: 'executed', D: 'executed' });
  deepEqual(r.executions(), ['A', 'B', 'C', 'D']);
  ok(!readdirSync(r.cacheDir).some((f) => f.includes('.tmp-')), 'no temp debris left');
});

test('power loss mid-publish leaves no visible record; stage re-executes', async () => {
  const r = rig();

  // Die after C's temp file is fsynced but before the atomic rename.
  await rejects(() => r.makeExecutor({ stageId: 'C', phase: 'tmp-written' }).run(), (err) => err instanceof SimulatedPowerLoss);

  // Atomicity: no committed C record exists, only an orphan temp file.
  const entries = readdirSync(r.cacheDir);
  ok(!entries.some((f) => f.startsWith('C-') && !f.includes('.tmp-')), 'no partial C record');
  ok(entries.some((f) => f.includes('.tmp-')), 'orphan temp file observed after crash');

  const report = await r.makeExecutor().run();
  equal(report.ok, true);
  const lines = r.executions();
  equal(count(lines, 'A'), 1);
  equal(count(lines, 'B'), 1);
  equal(count(lines, 'C'), 2, 'C re-executed after mid-publish crash');
  equal(count(lines, 'D'), 1);
  ok(!readdirSync(r.cacheDir).some((f) => f.includes('.tmp-')), 'temp debris swept on restart');
});

test('stale successes are not reused when inputs changed while powered off', async () => {
  const r = rig();

  const first = await r.makeExecutor().run();
  equal(first.ok, true);
  deepEqual(r.executions(), ['A', 'B', 'C', 'D']);

  // Input file for B changes while the machine is "off".
  writeFileSync(r.inputFile, 'v2');
  const second = await r.makeExecutor().run();
  equal(second.ok, true);
  deepEqual(second.stages, { A: 'reused', B: 'executed', C: 'executed', D: 'executed' });
  const lines = r.executions();
  equal(count(lines, 'A'), 1, 'A unaffected: reused');
  equal(count(lines, 'B'), 2, 'B invalidated by file change');
  equal(count(lines, 'C'), 2, 'C downstream of B: re-executed');
  equal(count(lines, 'D'), 2, 'D downstream of B: re-executed');
});
