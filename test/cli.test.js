import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

const RULES_OK = `
field temp: C;
group sensors = /^sensor-[0-9]+$/;
rule hot on sensors { alert critical when temp > 80C for 5m; }
`;
const EVENTS_OK =
  '{"id":"e1","time":"2026-01-01T00:00:00Z","device":"sensor-1","type":"temp","value":85}\n' +
  '{"id":"e2","time":"2026-01-01T00:06:00Z","device":"sensor-1","type":"temp","value":86}\n';

function setup(rules, events) {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  const rulesPath = join(dir, 'rules.dsl');
  const eventsPath = join(dir, 'events.jsonl');
  const outPath = join(dir, 'result.json');
  writeFileSync(rulesPath, rules);
  writeFileSync(eventsPath, events);
  return { dir, rulesPath, eventsPath, outPath };
}

// Note: this sandbox drops piped stdout/stderr of spawned node processes,
// so the child's stdio is redirected to files instead.
function run(args, dir) {
  const stdoutPath = join(dir, 'stdout.txt');
  const stderrPath = join(dir, 'stderr.txt');
  const outFd = openSync(stdoutPath, 'w');
  const errFd = openSync(stderrPath, 'w');
  let status;
  try {
    status = spawnSync(process.execPath, [CLI, ...args], {
      stdio: ['ignore', outFd, errFd],
    }).status;
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

test('successful run: exit 0 and result.json written', () => {
  const { dir, rulesPath, eventsPath, outPath } = setup(RULES_OK, EVENTS_OK);
  const r = run(['run', rulesPath, eventsPath, '--out', outPath], dir);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.ok, true);
  assert.equal(result.records[0].kind, 'alert');
  assert.equal(result.records[0].time, '2026-01-01T00:05:00.000Z');
});

test('acceptance 4a: unit error fails with exit 2 and rule line/col', () => {
  const { dir, rulesPath, eventsPath, outPath } = setup(
    'field temp: C;\nrule r on all {\n  alert info when temp > 80A;\n}\n', EVENTS_OK);
  const r = run(['run', rulesPath, eventsPath, '--out', outPath], dir);
  assert.equal(r.status, 2);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /unit mismatch/);
  assert.equal(result.errors[0].line, 3);
  assert.ok(result.errors[0].col > 0);
  assert.match(r.stderr, /rules\.dsl:3:/);
});

test('acceptance 4b: undeclared field fails with exit 2', () => {
  const { dir, rulesPath, eventsPath, outPath } = setup(
    'field temp: C;\nrule r on all { alert info when voltage > 5; }\n', EVENTS_OK);
  const r = run(['run', rulesPath, eventsPath, '--out', outPath], dir);
  assert.equal(r.status, 2);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.match(result.errors[0].message, /undeclared field or alias "voltage"/);
});

test('acceptance 4c: empty device group fails with exit 2', () => {
  const { dir, rulesPath, eventsPath, outPath } = setup(
    'field temp: C;\ngroup ghosts = /^ghost-[0-9]+$/;\nrule r on ghosts { alert info when temp > 80C; }\n',
    EVENTS_OK);
  const r = run(['run', rulesPath, eventsPath, '--out', outPath], dir);
  assert.equal(r.status, 2);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.match(result.errors[0].message, /matches no devices/);
});

test('unknown event id: exit 2, JSON error, processed events still present', () => {
  const events = EVENTS_OK +
    '{"id":"e3","time":"2026-01-01T00:07:00Z","device":"sensor-1","type":"temp","value":70,"replaces":"ghost"}\n';
  const { dir, rulesPath, eventsPath, outPath } = setup(RULES_OK, events);
  const r = run(['run', rulesPath, eventsPath, '--out', outPath], dir);
  assert.equal(r.status, 2);
  const result = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].event, 3); // event sequence number (JSONL line)
  assert.match(result.errors[0].message, /unknown event id "ghost"/);
  assert.deepEqual(result.records.map((x) => x.kind), ['alert']); // e1/e2 already processed
  assert.equal(result.stats.events, 2);
});

test('usage and IO errors exit 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  assert.equal(run([], dir).status, 1);
  assert.equal(run(['run', '/nonexistent.dsl', '/nonexistent.jsonl'], dir).status, 1);
});

test('without --out the result JSON goes to stdout', () => {
  const { dir, rulesPath, eventsPath } = setup(RULES_OK, EVENTS_OK);
  const r = run(['run', rulesPath, eventsPath], dir);
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.ok, true);
});
