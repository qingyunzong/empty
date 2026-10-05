'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Joiner, JoinError, validateRecord, WINDOW_MS } = require('../src/joiner');

const T0 = 1_700_000_000_000; // arbitrary aligned-ish base time
const W0 = Math.floor(T0 / WINDOW_MS) * WINDOW_MS;

function sample(sampleId, eventTime, extra = {}) {
  return { type: 'EVENT', event: 'SAMPLE_ACQUIRED', op: 'UPSERT', sampleId, eventTime, ...extra };
}
function qc(sampleId, eventTime, extra = {}) {
  return { type: 'EVENT', event: 'QC_RESULT', op: 'UPSERT', sampleId, eventTime, ...extra };
}
function retract(event, sampleId, eventTime) {
  return { type: 'EVENT', event, op: 'RETRACT', sampleId, eventTime };
}
function watermark(time) {
  return { type: 'WATERMARK', time };
}

test('joins out-of-order arrivals in the same window', () => {
  const j = new Joiner();
  assert.deepEqual(j.process(qc('S1', W0 + 2000)), []);
  const out = j.process(sample('S1', W0 + 1000));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'JOINED');
  assert.equal(out[0].sampleId, 'S1');
  assert.equal(out[0].windowStart, W0);
  assert.equal(out[0].windowEnd, W0 + WINDOW_MS);
  assert.equal(out[0].sample.event, 'SAMPLE_ACQUIRED');
  assert.equal(out[0].qc.event, 'QC_RESULT');
});

test('does not join events in different windows', () => {
  const j = new Joiner();
  j.process(sample('S1', W0 + 1000));
  assert.deepEqual(j.process(qc('S1', W0 + WINDOW_MS + 1000)), []);
  const out = j.process(watermark(W0 + 2 * WINDOW_MS));
  const expired = out.filter((o) => o.type === 'EXPIRED_UNJOINED');
  assert.equal(expired.length, 2);
  assert.equal(expired[0].side, 'SAMPLE_ACQUIRED');
  assert.equal(expired[0].windowStart, W0);
  assert.equal(expired[1].side, 'QC_RESULT');
  assert.equal(expired[1].windowStart, W0 + WINDOW_MS);
});

test('retract before close cascades WITHDRAW and re-judges at watermark', () => {
  const j = new Joiner();
  j.process(sample('S1', W0 + 1000));
  const joined = j.process(qc('S1', W0 + 2000));
  assert.equal(joined[0].type, 'JOINED');

  const withdrawn = j.process(retract('QC_RESULT', 'S1', W0 + 2000));
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].type, 'WITHDRAW');
  assert.equal(withdrawn[0].sampleId, 'S1');

  const closed = j.process(watermark(W0 + WINDOW_MS));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].type, 'EXPIRED_UNJOINED');
  assert.equal(closed[0].side, 'SAMPLE_ACQUIRED');
});

test('retract then re-upsert re-joins before close', () => {
  const j = new Joiner();
  j.process(sample('S1', W0 + 1000));
  j.process(qc('S1', W0 + 2000));
  j.process(retract('QC_RESULT', 'S1', W0 + 2000));
  const rejoined = j.process(qc('S1', W0 + 3000));
  assert.equal(rejoined.length, 1);
  assert.equal(rejoined[0].type, 'JOINED');
  assert.deepEqual(j.process(watermark(W0 + WINDOW_MS)), []);
});

test('retract of unjoined side emits nothing', () => {
  const j = new Joiner();
  j.process(sample('S1', W0 + 1000));
  assert.deepEqual(j.process(retract('SAMPLE_ACQUIRED', 'S1', W0 + 1000)), []);
});

test('unknown retract throws UNKNOWN_RETRACT', () => {
  const j = new Joiner();
  assert.throws(() => j.process(retract('QC_RESULT', 'NOPE', W0 + 1)), (err) => {
    assert.ok(err instanceof JoinError);
    assert.equal(err.code, 'UNKNOWN_RETRACT');
    return true;
  });
});

test('events after window close are LATE', () => {
  const j = new Joiner();
  j.process(sample('S1', W0 + 1000));
  j.process(watermark(W0 + WINDOW_MS));
  const lateUpsert = j.process(qc('S1', W0 + 2000));
  assert.equal(lateUpsert[0].type, 'LATE');
  assert.equal(lateUpsert[0].reason, 'WINDOW_CLOSED');
  const lateRetract = j.process(retract('SAMPLE_ACQUIRED', 'S1', W0 + 1000));
  assert.equal(lateRetract[0].type, 'LATE');
});

test('watermark expires multiple unmatched sides in sorted order', () => {
  const j = new Joiner();
  j.process(sample('B', W0 + 100));
  j.process(sample('A', W0 + 200));
  j.process(qc('C', W0 + 300));
  const out = j.process(watermark(W0 + WINDOW_MS));
  assert.deepEqual(out.map((o) => [o.sampleId, o.side]), [
    ['A', 'SAMPLE_ACQUIRED'],
    ['B', 'SAMPLE_ACQUIRED'],
    ['C', 'QC_RESULT'],
  ]);
});

test('non-monotonic watermark is a no-op', () => {
  const j = new Joiner();
  j.process(sample('S1', W0 + 1000));
  j.process(watermark(W0 + WINDOW_MS * 3));
  assert.deepEqual(j.process(watermark(W0 + WINDOW_MS)), []);
});

test('validateRecord rejects malformed input', () => {
  for (const bad of [
    null, 42, 'x', [],
    { type: 'EVENT' },
    { type: 'EVENT', event: 'NOPE', op: 'UPSERT', sampleId: 'S', eventTime: 1 },
    { type: 'EVENT', event: 'QC_RESULT', op: 'DELETE', sampleId: 'S', eventTime: 1 },
    { type: 'EVENT', event: 'QC_RESULT', op: 'UPSERT', sampleId: '', eventTime: 1 },
    { type: 'EVENT', event: 'QC_RESULT', op: 'UPSERT', sampleId: 'S', eventTime: -1 },
    { type: 'WATERMARK', time: 'soon' },
    { type: 'MYSTERY' },
  ]) {
    assert.throws(() => validateRecord(bad), (err) => err.code === 'MALFORMED');
  }
  assert.equal(validateRecord(sample('S', 1)).sampleId, 'S');
  assert.equal(validateRecord(watermark(5)).time, 5);
});
