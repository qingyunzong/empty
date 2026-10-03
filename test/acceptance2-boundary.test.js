import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpDir, writeJsonl, runCli, readJson, readJsonl } from './helpers.js';

// Intervals that merely touch at an endpoint must NOT produce a wait edge.
test('endpoint-touching overlap is not a wait', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  const events = [
    // Reserve window [0, 10000) on edge incident to n1.
    { type: 'reserve', id: 'rA', eventTs: 0, agv: 'A', edge: 'n1->n2', op: 'start' },
    { type: 'reserve', id: 'rA', eventTs: 10000, agv: 'A', edge: 'n1->n2', op: 'end' },
    // B is introduced by its own reserve on an unrelated edge.
    { type: 'reserve', id: 'rB', eventTs: 0, agv: 'B', edge: 'n5->n6', op: 'start' },
    { type: 'reserve', id: 'rB', eventTs: 5000, agv: 'B', edge: 'n5->n6', op: 'end' },
    // B stopped at n1 over [10000, 20000): touches rA's window exactly at t=10000.
    { type: 'ping', id: 'pB1', eventTs: 10000, agv: 'B', node: 'n1', speed: 0, op: 'set' },
    { type: 'ping', id: 'pB2', eventTs: 20000, agv: 'B', node: 'n1', speed: 1, op: 'set' },
  ];
  writeJsonl(inDir, 'events.jsonl', events);

  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readJsonl(join(outDir, 'waits.jsonl')), []);
  assert.deepEqual(readJson(join(outDir, 'cycles.json')), []);
  assert.deepEqual(readJsonl(join(outDir, 'invalid.jsonl')), []);
});

// Mirror direction: ping window ends exactly where the reserve window starts.
test('endpoint-touching overlap (mirrored) is not a wait', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  const events = [
    { type: 'reserve', id: 'rA', eventTs: 10000, agv: 'A', edge: 'n1->n2', op: 'start' },
    { type: 'reserve', id: 'rA', eventTs: 20000, agv: 'A', edge: 'n1->n2', op: 'end' },
    { type: 'reserve', id: 'rB', eventTs: 0, agv: 'B', edge: 'n5->n6', op: 'start' },
    { type: 'reserve', id: 'rB', eventTs: 5000, agv: 'B', edge: 'n5->n6', op: 'end' },
    // B stopped at n1 over [0, 10000): touches rA's window start exactly.
    { type: 'ping', id: 'pB1', eventTs: 0, agv: 'B', node: 'n1', speed: 0, op: 'set' },
    { type: 'ping', id: 'pB2', eventTs: 10000, agv: 'B', node: 'n1', speed: 1, op: 'set' },
  ];
  writeJsonl(inDir, 'events.jsonl', events);

  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(readJsonl(join(outDir, 'waits.jsonl')), []);
  assert.deepEqual(readJson(join(outDir, 'cycles.json')), []);
});
