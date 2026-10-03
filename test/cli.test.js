import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../index.js';

const MIN = 60000;

function setup(events) {
  const dir = mkdtempSync(join(tmpdir(), 'cold-'));
  const inDir = join(dir, 'in');
  const outDir = join(dir, 'out');
  mkdirSync(inDir);
  writeFileSync(join(inDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { inDir, outDir };
}

function runCli(args) {
  const out = [];
  const err = [];
  const code = main(args, { stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

test('CLI recall writes recall.json, evidence.jsonl, unexplained.jsonl, late.log', () => {
  const { inDir, outDir } = setup([
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't2', eventTs: 20 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't3', eventTs: 30 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't4', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't5', eventTs: 50 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't6', eventTs: 60 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't7', eventTs: 70 * MIN, zone: 'Z1', c: 4 },
    { kind: 'ship', id: 's1', eventTs: 0, lot: 'L1', zone: 'Z1', start: 5 * MIN, end: 25 * MIN },
    { kind: 'ship', id: 's2', eventTs: 0, lot: 'L2', zone: 'Z1', start: 5 * MIN, end: 45 * MIN },
    { kind: 'ship', id: 's3', eventTs: 0, lot: 'L3', zone: 'Z1', start: 25 * MIN, end: 65 * MIN },
    { kind: 'ship', id: 's4', eventTs: 0, lot: 'L4', zone: 'Z1', start: 45 * MIN, end: 65 * MIN },
  ]);
  const { code } = runCli(['recall', '--in', inDir, '--out', outDir]);
  assert.equal(code, 0);

  const recall = JSON.parse(readFileSync(join(outDir, 'recall.json'), 'utf8'));
  assert.equal(recall.watermark, 68 * MIN);
  assert.equal(recall.minimumSize, 2);
  assert.deepEqual(recall.solutions, [['L1', 'L3'], ['L2', 'L3'], ['L2', 'L4']]);
  assert.deepEqual(recall.exposedLots, ['L1', 'L2', 'L3', 'L4']);
  assert.equal(recall.unexplainedWindows, 3);

  const unexplained = readFileSync(join(outDir, 'unexplained.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(unexplained.length, 3);
  assert.deepEqual(unexplained[0].exposedLots, ['L1', 'L2']);

  const evidence = readFileSync(join(outDir, 'evidence.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(evidence.every((e) => e.type === 'exposure'));
  assert.ok(evidence.some((e) => e.lot === 'L1' && e.windowStart === 10 * MIN));

  assert.ok(existsSync(join(outDir, 'late.log')));
});

test('CLI empty anomalies produce an empty recall set, not an error', () => {
  const { inDir, outDir } = setup([
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't2', eventTs: 20 * MIN, zone: 'Z1', c: 6 },
  ]);
  const { code } = runCli(['recall', '--in', inDir, '--out', outDir]);
  assert.equal(code, 0);
  const recall = JSON.parse(readFileSync(join(outDir, 'recall.json'), 'utf8'));
  assert.equal(recall.minimumSize, 0);
  assert.deepEqual(recall.solutions, [[]]);
  assert.equal(readFileSync(join(outDir, 'unexplained.jsonl'), 'utf8'), '');
});

test('CLI reports TEMP_RANGE for physically impossible temperatures', () => {
  const { inDir, outDir } = setup([
    { kind: 'temp', id: 't1', eventTs: 10 * MIN, zone: 'Z1', c: 150 },
  ]);
  const { code, stderr } = runCli(['recall', '--in', inDir, '--out', outDir]);
  assert.equal(code, 1);
  assert.ok(stderr.includes('TEMP_RANGE'));
});

test('CLI late events land in late.log', () => {
  const { inDir, outDir } = setup([
    { kind: 'temp', id: 't1', eventTs: 40 * MIN, zone: 'Z1', c: 4 },
    { kind: 'temp', id: 't2', eventTs: 10 * MIN, zone: 'Z1', c: 20 },
    { kind: 'temp', id: 't3', eventTs: 20 * MIN, zone: 'Z1', c: 4 },
  ]);
  const { code } = runCli(['recall', '--in', inDir, '--out', outDir]);
  assert.equal(code, 0);
  const late = readFileSync(join(outDir, 'late.log'), 'utf8');
  assert.ok(late.includes('LATE temp t2'));
  assert.ok(late.includes('LATE temp t3'));
});
