import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpDir, writeJsonl, runCli, readJson, readJsonl } from './helpers.js';

// A two-agv mutual wait broken by retracting one ping.
test('retract of a ping breaks the cycle and invalidates the certificate', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  writeJsonl(inDir, 'events.jsonl', [
    { type: 'reserve', id: 'rA', eventTs: 0, agv: 'A', edge: 'n1->n2', op: 'start' },
    { type: 'reserve', id: 'rA', eventTs: 100000, agv: 'A', edge: 'n1->n2', op: 'end' },
    { type: 'reserve', id: 'rB', eventTs: 0, agv: 'B', edge: 'n2->n1', op: 'start' },
    { type: 'reserve', id: 'rB', eventTs: 100000, agv: 'B', edge: 'n2->n1', op: 'end' },
    // A stopped at n2 blocks B's edge n2->n1; B stopped at n1 blocks A's edge n1->n2.
    { type: 'ping', id: 'pA', eventTs: 10, agv: 'A', node: 'n2', speed: 0, op: 'set' },
    { type: 'ping', id: 'pB', eventTs: 10, agv: 'B', node: 'n1', speed: 0, op: 'set' },
    { type: 'retract', eventTs: 20000, kind: 'ping', id: 'pA' },
  ]);
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);

  const cycles = readJson(join(outDir, 'cycles.json'));
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].cycle, ['A', 'B']);
  assert.deepEqual(cycles[0].interval, [10, 100000]);

  const invalid = readJsonl(join(outDir, 'invalid.jsonl'));
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].invalidated, true);
  assert.equal(invalid[0].hash, cycles[0].hash);

  const waits = readJsonl(join(outDir, 'waits.jsonl'));
  assert.deepEqual(waits.map((w) => `${w.from}->${w.to}`), ['A->B']);
});

test('retract of a reserve removes its wait edges', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  writeJsonl(inDir, 'events.jsonl', [
    { type: 'reserve', id: 'rA', eventTs: 0, agv: 'A', edge: 'n1->n2', op: 'start' },
    { type: 'reserve', id: 'rA', eventTs: 100000, agv: 'A', edge: 'n1->n2', op: 'end' },
    { type: 'reserve', id: 'rB', eventTs: 0, agv: 'B', edge: 'n2->n1', op: 'start' },
    { type: 'reserve', id: 'rB', eventTs: 100000, agv: 'B', edge: 'n2->n1', op: 'end' },
    { type: 'ping', id: 'pA', eventTs: 10, agv: 'A', node: 'n2', speed: 0, op: 'set' },
    { type: 'ping', id: 'pB', eventTs: 10, agv: 'B', node: 'n1', speed: 0, op: 'set' },
    { type: 'retract', eventTs: 20000, kind: 'reserve', id: 'rB' },
  ]);
  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);
  const cycles = readJson(join(outDir, 'cycles.json'));
  const invalid = readJsonl(join(outDir, 'invalid.jsonl'));
  assert.equal(cycles.length, 1);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].hash, cycles[0].hash);
  // rB is gone, but A still waits for B (stopped at n1 on A's edge n1->n2).
  assert.deepEqual(
    readJsonl(join(outDir, 'waits.jsonl')).map((w) => `${w.from}->${w.to}`),
    ['A->B']
  );
});
