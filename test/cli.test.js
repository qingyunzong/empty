import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

function setup(ops, config = null) {
  const dir = mkdtempSync(join(tmpdir(), 'labsched-cli-'));
  const input = join(dir, 'ops.jsonl');
  writeFileSync(input, ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
  let configPath = null;
  if (config) {
    configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify(config));
  }
  return { dir, input, configPath };
}

function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) });
  return { code, stdout, stderr };
}

test('cli: clean run exits 0 and prints timeline with log root', () => {
  const { input } = setup([
    { op: 'budget', project: 'P', set: 100 },
    { op: 'enqueue', task: { id: 'T', project: 'P', volume: 10, priority: 0, segments: [{ temp: 37, duration: 5 }] } },
  ]);
  const r = runCli(['--input', input]);
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.match(result.logRoot, /^[0-9a-f]{64}$/);
  assert.equal(result.tasks.T.status, 'completed');
  assert.ok(Array.isArray(result.channels[0].events));
});

test('cli: volume overflow, negative budget and cooldown conflict exit 5', () => {
  const cases = [
    [
      { op: 'budget', project: 'P', set: 1e9 },
      { op: 'enqueue', task: { id: 'T', project: 'P', volume: 99999, priority: 0, segments: [{ temp: 37, duration: 5 }] } },
    ],
    [{ op: 'budget', project: 'P', set: -1 }],
    [
      { op: 'budget', project: 'P', set: 100 },
      {
        op: 'enqueue',
        task: { id: 'T', project: 'P', volume: 1, priority: 0, segments: [{ temp: 4, duration: 5 }, { temp: 90, duration: 5 }] },
      },
    ],
  ];
  for (const ops of cases) {
    const { input } = setup(ops);
    const r = runCli(['--input', input]);
    assert.equal(r.code, 5, `expected exit 5, got ${r.code}: ${r.stderr}`);
    const result = JSON.parse(r.stdout);
    assert.ok(result.failures.length > 0);
  }
});

test('cli: generic op failure exits 1', () => {
  const { input } = setup([{ op: 'abort', taskId: 'NOPE' }]);
  const r = runCli(['--input', input]);
  assert.equal(r.code, 1);
});

test('cli: --resume continues a recovered log without reapplying ops', () => {
  const { dir, input } = setup(
    [
      { op: 'budget', project: 'P', set: 100 },
      { op: 'enqueue', task: { id: 'T', project: 'P', volume: 10, priority: 0, segments: [{ temp: 37, duration: 5 }] } },
    ],
    { cooldownPerDegree: 0 }
  );
  const log = join(dir, 'run.log');
  const first = runCli(['--input', input, '--log', log]);
  assert.equal(first.code, 0, first.stderr);
  const second = runCli(['--input', input, '--log', log, '--resume']);
  assert.equal(second.code, 0, second.stderr);
  const a = JSON.parse(first.stdout);
  const b = JSON.parse(second.stdout);
  assert.equal(b.tasks.T.status, 'completed');
  assert.ok(b.logRoot !== a.logRoot, 'log chain continues across resume');
});

test('cli: invalid JSONL exits 2', () => {
  const dir = mkdtempSync(join(tmpdir(), 'labsched-cli-'));
  const input = join(dir, 'ops.jsonl');
  writeFileSync(input, '{"op":"budget"\n');
  const r = runCli(['--input', input]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /invalid JSON on line 1/);
});
