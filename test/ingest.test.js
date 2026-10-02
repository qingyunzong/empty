import test from 'node:test';
import assert from 'node:assert/strict';
import { Ingestor } from '../src/ingest.js';

const expectCode = (code) => (err) => err && err.code === code;

test('clock rollback beyond maxSkew raises ERR_CLOCK and leaves state unchanged', () => {
  const ing = new Ingestor({ maxSkewMs: 100 });
  ing.ingest({ id: 'a', type: 'run', start: 1000, end: 2000 });
  const before = ing.analyze();
  assert.throws(
    () => ing.ingest({ id: 'b', type: 'fault', start: 500, end: 900 }),
    expectCode('ERR_CLOCK'),
  );
  assert.equal(ing.events.length, 1);
  assert.deepEqual(ing.analyze(), before);
});

test('out-of-order delivery within maxSkew is accepted', () => {
  const ing = new Ingestor({ maxSkewMs: 100 });
  ing.ingest({ id: 'a', type: 'run', start: 1000, end: 2000 });
  const snap = ing.ingest({ id: 'b', type: 'fault', start: 950, end: 990 });
  assert.equal(snap.accepted, 2);
});

test('rollback exactly at maxSkew boundary is accepted', () => {
  const ing = new Ingestor({ maxSkewMs: 100 });
  ing.ingest({ id: 'a', type: 'run', start: 1000, end: 2000 });
  const snap = ing.ingest({ id: 'b', type: 'fault', start: 900, end: 950 });
  assert.equal(snap.accepted, 2);
});

test('conflicting duplicate id raises ERR_CONFLICT, exact duplicate is a no-op', () => {
  const ing = new Ingestor();
  ing.ingest({ id: 'a', type: 'run', start: 0, end: 10 });
  const snap = ing.ingest({ id: 'a', type: 'run', start: 0, end: 10 });
  assert.equal(snap.accepted, 1);
  assert.throws(
    () => ing.ingest({ id: 'a', type: 'run', start: 0, end: 11 }),
    expectCode('ERR_CONFLICT'),
  );
});

test('schema errors surface during ingestion', () => {
  const ing = new Ingestor();
  assert.throws(() => ing.ingest({ id: 'a', type: 'run', start: 5, end: 5 }), expectCode('ERR_SCHEMA'));
});
