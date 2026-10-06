import test from 'node:test';
import assert from 'node:assert/strict';
import { Joiner, JoinError, validateRecord, WINDOW_MS } from '../src/index.js';

const upsertSample = (eventId, sampleId, eventTime) => ({
  type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId, sampleId, eventTime,
});
const upsertQc = (eventId, sampleId, eventTime) => ({
  type: 'UPSERT', eventType: 'QC_RESULT', eventId, sampleId, eventTime,
});
const retract = (eventType, eventId, eventTime) => ({
  type: 'RETRACT', eventType, eventId, eventTime,
});
const watermark = (time) => ({ type: 'WATERMARK', time });

test('joins when both sides arrive out of order within the same window', () => {
  const j = new Joiner();
  assert.deepEqual(j.process(upsertQc('q1', 's1', 60000)), []);
  const out = j.process(upsertSample('e1', 's1', 1000));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'JOINED');
  assert.equal(out[0].sampleId, 's1');
  assert.equal(out[0].sampleEventId, 'e1');
  assert.equal(out[0].qcEventId, 'q1');
  assert.equal(out[0].windowStart, 0);
});

test('does not join events in different windows', () => {
  const j = new Joiner();
  j.process(upsertSample('e1', 's1', 1000));
  assert.deepEqual(j.process(upsertQc('q1', 's1', WINDOW_MS + 1000)), []);
  const out = j.process(watermark(2 * WINDOW_MS));
  const expired = out.filter((o) => o.type === 'EXPIRED_UNJOINED');
  assert.equal(expired.length, 2);
  assert.deepEqual(expired.map((o) => o.eventId).sort(), ['e1', 'q1']);
});

test('retract before close cascades WITHDRAW and expires the remaining side at watermark', () => {
  const j = new Joiner();
  j.process(upsertSample('e1', 's1', 1000));
  const joined = j.process(upsertQc('q1', 's1', 2000));
  assert.equal(joined[0].type, 'JOINED');
  const withdrawn = j.process(retract('SAMPLE_ACQUIRED', 'e1', 1000));
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].type, 'WITHDRAW');
  assert.equal(withdrawn[0].sampleEventId, 'e1');
  assert.equal(withdrawn[0].qcEventId, 'q1');
  const closed = j.process(watermark(WINDOW_MS));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].type, 'EXPIRED_UNJOINED');
  assert.equal(closed[0].side, 'QC_RESULT');
  assert.equal(closed[0].eventId, 'q1');
});

test('retract re-judges: remaining side can join a later event in the same window', () => {
  const j = new Joiner();
  j.process(upsertSample('e1', 's1', 1000));
  j.process(upsertQc('q1', 's1', 2000));
  j.process(retract('SAMPLE_ACQUIRED', 'e1', 1000));
  const out = j.process(upsertSample('e2', 's1', 3000));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'JOINED');
  assert.equal(out[0].sampleEventId, 'e2');
  assert.equal(out[0].qcEventId, 'q1');
});

test('events arriving after their window closed are reported LATE', () => {
  const j = new Joiner();
  j.process(watermark(WINDOW_MS));
  const lateUpsert = j.process(upsertSample('e1', 's1', 1000));
  assert.equal(lateUpsert.length, 1);
  assert.equal(lateUpsert[0].type, 'LATE');
  const lateRetract = j.process(retract('SAMPLE_ACQUIRED', 'e1', 1000));
  assert.equal(lateRetract.length, 1);
  assert.equal(lateRetract[0].type, 'LATE');
});

test('retract of an unknown live event throws UNKNOWN_RETRACT', () => {
  const j = new Joiner();
  assert.throws(
    () => j.process(retract('SAMPLE_ACQUIRED', 'nope', 1000)),
    (err) => err instanceof JoinError && err.code === 'UNKNOWN_RETRACT',
  );
});

test('upsert of the same eventId replaces the event', () => {
  const j = new Joiner();
  j.process(upsertSample('e1', 's1', 1000));
  j.process(upsertSample('e1', 's1', 5000)); // re-upsert, still no qc side
  const out = j.process(upsertQc('q1', 's1', 6000));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'JOINED');
  assert.equal(out[0].sampleTime, 5000);
});

test('brute-force pairing matches multiple events per sampleId in time order', () => {
  const j = new Joiner();
  j.process(upsertSample('e1', 's1', 1000));
  j.process(upsertSample('e2', 's1', 2000));
  j.process(upsertQc('q1', 's1', 1500));
  const out = j.process(upsertQc('q2', 's1', 2500));
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'JOINED');
  assert.equal(out[0].sampleEventId, 'e2');
  assert.equal(out[0].qcEventId, 'q2');
  const closed = j.process(watermark(WINDOW_MS));
  assert.deepEqual(closed, []);
});

test('validateRecord rejects malformed records with MALFORMED', () => {
  const bad = [
    null,
    [],
    'x',
    {},
    { type: 'NOPE' },
    { type: 'UPSERT', eventType: 'BAD', eventId: 'e', sampleId: 's', eventTime: 1 },
    { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: '', sampleId: 's', eventTime: 1 },
    { type: 'UPSERT', eventType: 'SAMPLE_ACQUIRED', eventId: 'e', sampleId: 's', eventTime: -1 },
    { type: 'RETRACT', eventType: 'QC_RESULT', eventId: 'e' },
    { type: 'WATERMARK' },
    { type: 'WATERMARK', time: 'now' },
  ];
  for (const record of bad) {
    assert.throws(
      () => validateRecord(record),
      (err) => err instanceof JoinError && err.code === 'MALFORMED',
      JSON.stringify(record),
    );
  }
});

test('non-advancing watermarks are ignored', () => {
  const j = new Joiner();
  j.process(upsertSample('e1', 's1', 1000));
  assert.deepEqual(j.process(watermark(WINDOW_MS)), [
    {
      type: 'EXPIRED_UNJOINED',
      windowStart: 0,
      side: 'SAMPLE_ACQUIRED',
      eventId: 'e1',
      sampleId: 's1',
      eventTime: 1000,
    },
  ]);
  assert.deepEqual(j.process(watermark(WINDOW_MS)), []);
  assert.deepEqual(j.process(watermark(WINDOW_MS - 1)), []);
});
