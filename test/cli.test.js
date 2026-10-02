import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/agv.js', import.meta.url));

function makeWorkspace(lines) {
  const root = mkdtempSync(path.join(tmpdir(), 'agv-test-'));
  const inDir = path.join(root, 'in');
  const outDir = path.join(root, 'out');
  mkdirSync(inDir);
  writeFileSync(path.join(inDir, 'events.jsonl'), lines.join('\n') + '\n');
  return { inDir, outDir };
}

function runCli(inDir, outDir, extra = []) {
  return spawnSync(
    process.execPath,
    [BIN, 'deadlock', '--in', inDir, '--out', outDir, ...extra],
    { encoding: 'utf8' },
  );
}

const RING = [
  '{"op":"reserve","eventTs":0,"agv":"A","edge":"E3","id":"R1"}',
  '{"op":"ping","eventTs":100,"agv":"A","node":"N3","speed":0.2,"id":"P1"}',
  '{"op":"reserve","eventTs":0,"agv":"B","edge":"E1","id":"R2"}',
  '{"op":"ping","eventTs":100,"agv":"B","node":"N1","speed":0.1,"id":"P2"}',
  '{"op":"reserve","eventTs":0,"agv":"C","edge":"E2","id":"R3"}',
  '{"op":"ping","eventTs":100,"agv":"C","node":"N2","speed":0.3,"id":"P3"}',
  '{"op":"reserve","eventTs":1000,"agv":"A","edge":"E1","id":"R4"}',
  '{"op":"reserve","eventTs":1000,"agv":"B","edge":"E2","id":"R5"}',
  '{"op":"reserve","eventTs":1000,"agv":"C","edge":"E3","id":"R6"}',
];

test('CLI end-to-end: ring detected, late cancel invalidates it, all four outputs written', () => {
  const { inDir, outDir } = makeWorkspace([
    ...RING,
    '{"op":"ping","eventTs":100000,"agv":"A","node":"N9","speed":1.0,"id":"P9"}',
    '{"op":"cancel","eventTs":1000,"reserveId":"R4"}',
  ]);
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 0, proc.stderr);

  for (const name of ['cycles.json', 'waits.jsonl', 'invalid.jsonl', 'late.log']) {
    assert.ok(existsSync(path.join(outDir, name)), `missing ${name}`);
  }

  const cycles = JSON.parse(readFileSync(path.join(outDir, 'cycles.json'), 'utf8'));
  assert.equal(cycles.cycleCount, 0);
  assert.deepEqual(cycles.cycles, []);

  const invalid = readFileSync(path.join(outDir, 'invalid.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].status, 'invalidated');
  assert.match(invalid[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(invalid[0].cycle, ['A', 'B', 'C']);
  assert.equal(invalid[0].invalidatedBy.op, 'cancel');

  const waits = readFileSync(path.join(outDir, 'waits.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    waits.map((w) => `${w.from}->${w.to}`).sort(),
    ['B->C', 'C->A'],
  );

  const lateLog = readFileSync(path.join(outDir, 'late.log'), 'utf8');
  assert.match(lateLog, /LATE eventTs=1000 watermark=98000 op=cancel/);
});

test('CLI: active ring lands in cycles.json with evidence', () => {
  const { inDir, outDir } = makeWorkspace(RING);
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 0, proc.stderr);
  const cycles = JSON.parse(readFileSync(path.join(outDir, 'cycles.json'), 'utf8'));
  assert.equal(cycles.cycleCount, 1);
  const cert = cycles.cycles[0];
  assert.deepEqual(cert.cycle, ['A', 'B', 'C']);
  assert.equal(cert.edges.length, 3);
  assert.match(cert.hash, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(path.join(outDir, 'invalid.jsonl'), 'utf8'), '');
  assert.equal(readFileSync(path.join(outDir, 'late.log'), 'utf8'), '');
});

test('CLI: ping for unknown agv exits 1 with UNKNOWN_AGV', () => {
  const { inDir, outDir } = makeWorkspace([
    '{"op":"reserve","eventTs":0,"agv":"A","edge":"E1","id":"R1"}',
    '{"op":"ping","eventTs":5,"agv":"GHOST","node":"N1","speed":0.1,"id":"P1"}',
  ]);
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /UNKNOWN_AGV/);
});

test('CLI: duplicate reserveId exits 1 with DUP_RESERVE', () => {
  const { inDir, outDir } = makeWorkspace([
    '{"op":"reserve","eventTs":0,"agv":"A","edge":"E1","id":"R1"}',
    '{"op":"reserve","eventTs":1,"agv":"B","edge":"E2","id":"R1"}',
  ]);
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /DUP_RESERVE/);
});

test('CLI: malformed input exits 1 with BAD_JSON', () => {
  const { inDir, outDir } = makeWorkspace(['{oops']);
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 1);
  assert.match(proc.stderr, /BAD_JSON/);
});

test('CLI: missing arguments exits 2 with usage', () => {
  const proc = spawnSync(process.execPath, [BIN, 'deadlock'], { encoding: 'utf8' });
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /usage: agv deadlock/);
});

test('CLI: events are merged from multiple jsonl files in sorted order', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'agv-test-'));
  const inDir = path.join(root, 'in');
  const outDir = path.join(root, 'out');
  mkdirSync(inDir);
  writeFileSync(
    path.join(inDir, '02-second.jsonl'),
    '{"op":"reserve","eventTs":1000,"agv":"B","edge":"E1","id":"R2"}\n',
  );
  writeFileSync(
    path.join(inDir, '01-first.jsonl'),
    '{"op":"reserve","eventTs":0,"agv":"A","edge":"E1","id":"R1"}\n' +
      '{"op":"ping","eventTs":10,"agv":"A","node":"N1","speed":0.1,"id":"P1"}\n',
  );
  const proc = runCli(inDir, outDir);
  assert.equal(proc.status, 0, proc.stderr);
  const waits = readFileSync(path.join(outDir, 'waits.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].from, 'B');
  assert.equal(waits[0].to, 'A');
});
