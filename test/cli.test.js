import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'src', 'cli.js');

function setup(events, rules) {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-cli-'));
  const eventsPath = join(dir, 'events.json');
  const rulesPath = join(dir, 'rules.json');
  const outPath = join(dir, 'out.json');
  writeFileSync(eventsPath, JSON.stringify(events));
  writeFileSync(rulesPath, JSON.stringify(rules));
  return { eventsPath, rulesPath, outPath };
}

function runCli(args) {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-cli-io-'));
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  let proc;
  try {
    proc = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', outFd, errFd] });
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  if (proc.error) throw proc.error;
  return {
    status: proc.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

const RULES = [
  { id: 'r1', alarm: 'hot', when: [{ type: 'temperature', op: '>=', value: 90 }] },
  { id: 'r2', alarm: 'critical', when: [{ alarm: 'hot' }, { type: 'vibration', op: '>=', value: 5 }] },
];

test('CLI runs the command stream and writes the output file', () => {
  const events = [
    { op: 'append', event: { id: 'e1', seq: 1, type: 'temperature', value: 95 } },
    { op: 'append', event: { id: 'e2', seq: 2, type: 'vibration', value: 7 } },
    { op: 'append', event: { id: 'e3', seq: 3, type: 'temperature', value: 91 } },
    { op: 'retract', id: 'e1' },
    { op: 'retract', id: 'e3' },
    { op: 'undo' },
  ];
  const { eventsPath, rulesPath, outPath } = setup(events, RULES);
  const proc = runCli(['alarms', eventsPath, rulesPath, '-o', outPath]);

  assert.equal(proc.status, 0, proc.stderr);
  assert.equal(proc.stderr, '');
  const out = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(out.ok, true);
  assert.equal(out.steps.length, 6);
  assert.deepEqual(out.steps[3], { index: 3, op: 'retract', ok: true, added: [], removed: [] });
  assert.deepEqual(out.steps[4], {
    index: 4,
    op: 'retract',
    ok: true,
    added: [],
    removed: ['critical', 'hot'],
  });
  assert.deepEqual(out.steps[5], {
    index: 5,
    op: 'undo',
    ok: true,
    added: ['critical', 'hot'],
    removed: [],
  });

  const names = out.alarms.map((entry) => entry.alarm);
  assert.deepEqual(names, ['critical', 'hot']);
  const hot = out.alarms.find((entry) => entry.alarm === 'hot');
  assert.deepEqual(hot.proofs.map((p) => p.facts), [['e3']]);
});

test('CLI supports plain events, addRule replay, removeRule and stdout output', () => {
  const events = [
    { id: 'e1', seq: 1, type: 'temperature', value: 95 },
    { op: 'addRule', rule: { id: 'r9', alarm: 'hot2', when: [{ type: 'temperature', op: '>=', value: 90 }] } },
    { op: 'removeRule', id: 'r1' },
  ];
  const { eventsPath, rulesPath } = setup(events, RULES);
  const proc = runCli(['alarms', eventsPath, rulesPath]);

  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.ok, true);
  const names = out.alarms.map((entry) => entry.alarm);
  assert.deepEqual(names, ['hot2']);
});

test('CLI reports structured per-command errors and keeps going', () => {
  const events = [
    { op: 'append', event: { id: 'e1', seq: 1, type: 'temperature', value: 95, bogus: 1 } },
    { op: 'append', event: { id: 'e2', seq: 2, type: 'temperature', value: 95 } },
    { op: 'append', event: { id: 'e2', seq: 3, type: 'temperature', value: 96 } },
    { op: 'retract', id: 'ghost' },
    { op: 'levitate' },
  ];
  const { eventsPath, rulesPath, outPath } = setup(events, RULES);
  const proc = runCli(['alarms', eventsPath, rulesPath, '-o', outPath]);

  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(out.ok, false);
  assert.equal(out.steps[0].ok, false);
  assert.equal(out.steps[0].error.code, 'UNKNOWN_FIELD');
  assert.equal(out.steps[1].ok, true);
  assert.equal(out.steps[2].error.code, 'DUPLICATE_ID');
  assert.equal(out.steps[3].error.code, 'UNKNOWN_EVENT');
  assert.equal(out.steps[4].error.code, 'UNKNOWN_OP');
  assert.deepEqual(out.alarms.map((entry) => entry.alarm), ['hot']);
});

test('CLI exits 1 with a structured error for a bad rules file', () => {
  const { eventsPath, rulesPath } = setup([], [
    { id: 'r1', alarm: 'a', when: [{ type: 'temperature' }] },
    { id: 'r1', alarm: 'b', when: [{ type: 'pressure' }] },
  ]);
  const proc = runCli(['alarms', eventsPath, rulesPath]);
  assert.equal(proc.status, 1);
  const payload = JSON.parse(proc.stderr);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DUPLICATE_ID');
});

test('CLI exits 1 for invalid JSON and 2 for bad usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'alarm-cli-'));
  const eventsPath = join(dir, 'events.json');
  const rulesPath = join(dir, 'rules.json');
  writeFileSync(eventsPath, 'not json');
  writeFileSync(rulesPath, '[]');

  const badJson = runCli(['alarms', eventsPath, rulesPath]);
  assert.equal(badJson.status, 1);
  assert.equal(JSON.parse(badJson.stderr).error.code, 'BAD_JSON');

  const usage = runCli([]);
  assert.equal(usage.status, 2);
  assert.equal(JSON.parse(usage.stderr).error.code, 'USAGE');

  const missing = runCli(['alarms', join(dir, 'nope.json'), rulesPath]);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'READ_FAILED');
});
