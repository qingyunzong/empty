import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { tmpDir, writeJsonl, runCli, readJson, readJsonl } from './helpers.js';

// Three AGVs in a circular wait, resolved by one late cancel.
// A stopped at n1, B stopped at n2, C stopped at n3 (all from t=20000 on).
// A reserves n3->n9 (waits for C), C reserves n2->n7 (waits for B),
// B reserves n1->n8 (waits for A). Cycle A->C->B->A over [20000, 90000).
// A late cancel of B's reserve at eventTs=15000 empties the B->A overlap.
test('three-agv cycle is resolved by a late cancel', () => {
  const inDir = join(tmpDir(), 'in');
  const outDir = join(tmpDir(), 'out');
  const events = [
    { type: 'reserve', id: 'rA', eventTs: 10000, agv: 'A', edge: 'n3->n9', op: 'start' },
    { type: 'reserve', id: 'rB', eventTs: 10000, agv: 'B', edge: 'n1->n8', op: 'start' },
    { type: 'reserve', id: 'rC', eventTs: 10000, agv: 'C', edge: 'n2->n7', op: 'start' },
    { type: 'reserve', id: 'rA', eventTs: 90000, agv: 'A', edge: 'n3->n9', op: 'end' },
    { type: 'reserve', id: 'rB', eventTs: 90000, agv: 'B', edge: 'n1->n8', op: 'end' },
    { type: 'reserve', id: 'rC', eventTs: 90000, agv: 'C', edge: 'n2->n7', op: 'end' },
    { type: 'ping', id: 'pA1', eventTs: 20000, agv: 'A', node: 'n1', speed: 0, op: 'set' },
    { type: 'ping', id: 'pB1', eventTs: 20000, agv: 'B', node: 'n2', speed: 0, op: 'set' },
    { type: 'ping', id: 'pC1', eventTs: 20000, agv: 'C', node: 'n3', speed: 0, op: 'set' },
    // On-time event that pushes the watermark to 98000.
    { type: 'ping', id: 'pA2', eventTs: 100000, agv: 'A', node: 'n1', speed: 1, op: 'set' },
    // Late cancel: 15000 < watermark 98000. Truncates rB to [10000,15000),
    // which no longer overlaps A's stopped window [20000,100000).
    { type: 'cancel', eventTs: 15000, reserveId: 'rB', op: 'cancel' },
  ];
  writeJsonl(inDir, 'events.jsonl', events);

  const res = runCli(inDir, outDir);
  assert.equal(res.status, 0, res.stderr);

  const cycles = readJson(join(outDir, 'cycles.json'));
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].cycle, ['A', 'C', 'B']);
  assert.deepEqual(cycles[0].interval, [20000, 90000]);
  assert.equal(cycles[0].edges.length, 3);
  const edgeKeys = cycles[0].edges.map((e) => `${e.from}->${e.to}`).sort();
  assert.deepEqual(edgeKeys, ['A->C', 'B->A', 'C->B']);
  assert.match(cycles[0].hash, /^[0-9a-f]{64}$/);

  const invalid = readJsonl(join(outDir, 'invalid.jsonl'));
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].invalidated, true);
  assert.equal(invalid[0].hash, cycles[0].hash, 'invalidation keeps original cert hash');

  const lateLog = readFileSync(join(outDir, 'late.log'), 'utf8');
  assert.match(lateLog, /type=cancel/);
  assert.match(lateLog, /id=rB/);
  assert.match(lateLog, /eventTs=15000/);

  const waits = readJsonl(join(outDir, 'waits.jsonl'));
  const waitKeys = waits.map((w) => `${w.from}->${w.to}`).sort();
  assert.deepEqual(waitKeys, ['A->C', 'C->B'], 'B->A wait edge removed by late cancel');
});
