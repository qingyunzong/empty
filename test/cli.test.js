import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'src', 'cli.js');

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
  const dir = mkdtempSync(join(tmpdir(), 'alarm-cli-stdio-'));
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  let status;
  try {
    const res = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    });
    status = res.status;
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
  return {
    status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

const rules = [
  {
    id: 'r1',
    when: [{ fact: { type: 'temperature', value: { $gte: 90 } } }],
    derive: { alarm: 'hot' },
  },
  {
    id: 'r2',
    when: [{ alarm: 'hot' }, { fact: { type: 'pressure', value: { $gte: 50 } } }],
    derive: { alarm: 'critical' },
  },
];

test('CLI writes derived alarms to -o output file and exits 0', () => {
  const { eventsPath, rulesPath, outPath } = setup(
    [
      { cmd: 'append', fact: { id: 'e1', type: 'temperature', value: 95 } },
      { cmd: 'append', fact: { id: 'e2', type: 'pressure', value: 60 } },
    ],
    rules,
  );
  const res = runCli(['alarms', eventsPath, rulesPath, '-o', outPath]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  const out = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.deepEqual(
    out.alarms.map((a) => a.alarm),
    ['hot', 'critical'],
  );
  assert.deepEqual(out.alarms[1].proofs, [{ rule: 'r2', facts: ['e1', 'e2'] }]);
  assert.deepEqual(out.dependencies, { r1: [], r2: ['r1'] });
});

test('CLI supports undo and retract in the command stream', () => {
  const { eventsPath, rulesPath, outPath } = setup(
    [
      { cmd: 'append', fact: { id: 'e1', type: 'temperature', value: 95 } },
      { cmd: 'append', fact: { id: 'e2', type: 'pressure', value: 60 } },
      { cmd: 'undo' },
      { cmd: 'append', fact: { id: 'e3', type: 'pressure', value: 70 } },
      { cmd: 'retract', id: 'e1' },
    ],
    rules,
  );
  const res = runCli(['alarms', eventsPath, rulesPath, '-o', outPath]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.deepEqual(out.alarms, []);
  assert.deepEqual(
    out.facts.map((f) => f.id),
    ['e3'],
  );
});

test('CLI writes state to stdout when -o is omitted', () => {
  const { eventsPath, rulesPath } = setup([], rules);
  const res = runCli(['alarms', eventsPath, rulesPath]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.alarms, []);
  assert.equal(out.rules.length, 2);
});

test('CLI emits structured JSON error on stderr and exits 1 for bad commands', () => {
  const { eventsPath, rulesPath, outPath } = setup(
    [
      { cmd: 'append', fact: { id: 'e1', type: 'temperature', value: 95 } },
      { cmd: 'append', fact: { id: 'e1', type: 'pressure', value: 10 } },
    ],
    rules,
  );
  const res = runCli(['alarms', eventsPath, rulesPath, '-o', outPath]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  const payload = JSON.parse(res.stderr);
  assert.equal(payload.error.code, 'DUPLICATE_ID');
  assert.match(payload.error.message, /e1/);
  assert.equal(existsSync(outPath), false);
});

test('CLI reports invalid initial rules with structured error', () => {
  const { eventsPath, rulesPath } = setup([], [{ id: 'r1', when: [], derive: { alarm: 'a' } }]);
  const res = runCli(['alarms', eventsPath, rulesPath]);
  assert.equal(res.status, 1);
  assert.equal(JSON.parse(res.stderr).error.code, 'INVALID_RULE');
});

test('CLI reports unreadable or malformed input files', () => {
  const { eventsPath, rulesPath } = setup([], rules);
  const missing = runCli(['alarms', eventsPath, '/nonexistent/rules.json']);
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stderr).error.code, 'READ_ERROR');

  writeFileSync(rulesPath, '{ not json');
  const bad = runCli(['alarms', eventsPath, rulesPath]);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stderr).error.code, 'INVALID_JSON');
});

test('CLI usage errors exit with code 2', () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(['bogus']).status, 2);
  const { eventsPath, rulesPath } = setup([], rules);
  assert.equal(runCli(['alarms', eventsPath]).status, 2);
  assert.equal(runCli(['alarms', eventsPath, rulesPath, '--nope']).status, 2);
});
