import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSamples, contextFor } from '../src/samples.js';

test('samples without corrections yield a single version', () => {
  const { versions } = parseSamples(`
{"type":"batch","size":50}
{"type":"sample","id":"S1","defects":1}
{"type":"sample","id":"S2","defects":0}
`, 's.jsonl');
  assert.equal(versions.length, 1);
  assert.deepEqual(contextFor(versions[0]), {
    batch_size: 50, sampled: 2, defects: 1, severity: 'minor',
  });
});

test('each correction produces a new version, history preserved', () => {
  const { versions } = parseSamples(`
{"type":"sample","id":"S1","defects":0}
{"type":"sample","id":"S2","defects":1,"severity":"major"}
{"type":"correction","id":"S2","defects":0}
{"type":"correction","id":"S1","defects":2,"severity":"critical"}
`, 's.jsonl');
  assert.equal(versions.length, 3);
  assert.equal(contextFor(versions[0]).defects, 1);
  assert.equal(contextFor(versions[1]).defects, 0);
  assert.equal(contextFor(versions[2]).defects, 2);
  assert.equal(contextFor(versions[2]).severity, 'critical');
});

test('batch size defaults to the sample count', () => {
  const { versions } = parseSamples('{"type":"sample","id":"S1"}\n', 's.jsonl');
  assert.equal(versions[0].batchSize, 1);
});

test('jsonl errors carry the line number', () => {
  assert.throws(
    () => parseSamples('{"type":"sample","id":"S1"}\nnot json\n', 's.jsonl'),
    (err) => err.line === 2 && /s\.jsonl:2: invalid JSON/.test(err.message),
  );
  assert.throws(
    () => parseSamples('{"type":"sample","id":"S1"}\n{"type":"sample","id":"S1"}\n', 's.jsonl'),
    (err) => err.line === 2 && /duplicate sample id 'S1'/.test(err.message),
  );
  assert.throws(
    () => parseSamples('{"type":"correction","id":"ZZZ","defects":1}\n', 's.jsonl'),
    (err) => err.line === 1 && /unknown sample id 'ZZZ'/.test(err.message),
  );
  assert.throws(
    () => parseSamples('{"type":"sample","id":"S1","defects":-1}\n', 's.jsonl'),
    /must be a non-negative integer/,
  );
});
