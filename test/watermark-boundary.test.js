import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  makeWorkspace,
  writeEvents,
  runCli,
  readJsonl,
  sensor,
} from '../testlib/helpers.js';

test('sample exactly at the watermark is processed on time (not late)', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    sensor('p3', 3000, 'pressure', 1200), // advances watermark to 2000
    sensor('p-boundary', 2000, 'pressure', 500), // ts == watermark: on time
    sensor('p6', 6000, 'pressure', 1200),
    sensor('t6', 6000, 'temperature', 200),
  ]);
  const result = runCli(inDir, outDir, { args: ['--window-ms', '5000'] });
  assert.equal(result.status, 0, result.stderr);

  const late = readJsonl(path.join(outDir, 'late.log'));
  assert.deepEqual(late, [], 'boundary sample must not be logged late');

  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  assert.ok(
    !states.some((s) => s.state === 'ARM' && s.ts === 3000),
    'boundary low sample must break the 3s run, so no ARM@3000',
  );

  const proof = JSON.parse(
    fs.readFileSync(path.join(outDir, 'proof.json'), 'utf8'),
  );
  assert.equal(proof.counts.late, 0);
  assert.equal(proof.counts.sensor, 6, 'boundary sample must be applied');
});

test('value exactly equal to the limit does not exceed it', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    sensor('p0', 0, 'pressure', 1000), // == default pressure limit
    sensor('t0', 0, 'temperature', 200),
    sensor('p4', 4000, 'pressure', 1000),
    sensor('t4', 4000, 'temperature', 180), // == default temp limit
  ]);
  const result = runCli(inDir, outDir);
  assert.equal(result.status, 0, result.stderr);
  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  assert.deepEqual(states, [], 'no ARM may be emitted at exact-limit values');
});

test('condition held for exactly durationMs still ARMs', () => {
  const { inDir, outDir } = makeWorkspace();
  writeEvents(inDir, [
    sensor('p0', 0, 'pressure', 1200),
    sensor('t0', 0, 'temperature', 200),
    sensor('p2', 2000, 'pressure', 1200),
    sensor('t2', 2000, 'temperature', 200),
    sensor('p3', 3000, 'pressure', 500), // breaks the run at exactly 3000
    sensor('p6', 6000, 'pressure', 500),
  ]);
  const result = runCli(inDir, outDir);
  assert.equal(result.status, 0, result.stderr);
  const states = readJsonl(path.join(outDir, 'states.jsonl'));
  const ops = states.map((s) => `${s.op}:${s.state}@${s.ts}`);
  assert.ok(ops.includes('EMIT:ARM@3000'), `expected ARM@3000 in ${ops}`);
  assert.ok(ops.includes('EMIT:DISARM@3000'), `expected DISARM@3000 in ${ops}`);
});
