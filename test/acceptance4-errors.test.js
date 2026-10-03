import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpDir, writeJsonl, runCli } from './helpers.js';

test('duplicate reserveId reports DUP_RESERVE (exit 2)', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  writeJsonl(inDir, 'events.jsonl', [
    { type: 'reserve', id: 'r1', eventTs: 0, agv: 'A', edge: 'n1->n2', op: 'start' },
    { type: 'reserve', id: 'r1', eventTs: 10, agv: 'B', edge: 'n3->n4', op: 'start' },
  ]);
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /DUP_RESERVE/);
  assert.match(res.stderr, /r1/);
});

test('ping referencing unknown agv reports UNKNOWN_AGV (exit 3)', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  writeJsonl(inDir, 'events.jsonl', [
    { type: 'ping', id: 'p1', eventTs: 0, agv: 'GHOST', node: 'n1', speed: 0, op: 'set' },
  ]);
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 3);
  assert.match(res.stderr, /UNKNOWN_AGV/);
  assert.match(res.stderr, /GHOST/);
});

test('reserveId may be reused after its reserve was retracted', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  writeJsonl(inDir, 'events.jsonl', [
    { type: 'reserve', id: 'r1', eventTs: 0, agv: 'A', edge: 'n1->n2', op: 'start' },
    { type: 'retract', eventTs: 10, kind: 'reserve', id: 'r1' },
    { type: 'reserve', id: 'r1', eventTs: 20, agv: 'B', edge: 'n3->n4', op: 'start' },
  ]);
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);
});
