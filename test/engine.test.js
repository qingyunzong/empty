import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, parseJsonl, TempRangeError, ParseError } from '../src/index.js';
import { T0, MIN, temp, door, ship, retract } from '../testlib/helpers.js';

// Acceptance 4: no anomalies -> empty recall set, not an error.
test('empty anomaly scenario outputs the empty set', () => {
  const events = [
    temp('t1', T0, 'A', -20),
    temp('t2', T0 + MIN, 'A', -22),
    ship('s1', T0 + 2 * MIN, 'L1', 'A', T0 - 10_000, T0 + 3 * MIN),
  ];
  const result = analyze(events);
  assert.equal(result.counts.windows, 0);
  assert.equal(result.recall.minimalSize, 0);
  assert.deepEqual(result.recall.solutions, [[]]);
  assert.deepEqual(result.recall.lots, []);
  assert.equal(result.evidence.length, 0);
});

test('completely empty input yields an empty recall set', () => {
  const result = analyze([]);
  assert.equal(result.recall.minimalSize, 0);
  assert.deepEqual(result.recall.solutions, [[]]);
  assert.equal(result.watermark, null);
});

test('ship window touching anomaly endpoints is not exposure', () => {
  const events = [
    temp('t1', T0, 'A', -10),
    temp('t2', T0 + 2 * MIN, 'A', -20),
    ship('s1', T0 + 3 * MIN, 'L1', 'A', T0 - 5 * MIN, T0),
    ship('s2', T0 + 3 * MIN + 1, 'L2', 'A', T0 + 2 * MIN, T0 + 4 * MIN),
    ship('s3', T0 + 3 * MIN + 2, 'L3', 'A', T0 + MIN, T0 + 4 * MIN),
  ];
  const result = analyze(events);
  assert.equal(result.counts.unexplainedWindows, 1);
  assert.deepEqual(result.recall.solutions, [['L3']]);
  assert.deepEqual(result.evidence.map((e) => e.lot), ['L3']);
});

test('retracting a ship removes it from results and evidence', () => {
  const base = [
    temp('t1', T0, 'A', -10),
    temp('t2', T0 + MIN, 'A', -20),
    ship('s1', T0 + 2 * MIN, 'L1', 'A', T0 - 10_000, T0 + 2 * MIN),
    ship('s2', T0 + 2 * MIN + 1, 'L2', 'A', T0 - 10_000, T0 + 2 * MIN),
  ];
  const before = analyze(base);
  assert.deepEqual(before.recall.solutions, [['L1'], ['L2']]);
  assert.equal(before.evidence.length, 2);

  const after = analyze([...base, retract(T0 + 3 * MIN, 'ship', 's1')]);
  assert.deepEqual(after.recall.solutions, [['L2']]);
  assert.equal(after.evidence.length, 1);
  assert.equal(after.evidence[0].lot, 'L2');
});

test('op=retract on an event also retracts it', () => {
  const events = [
    temp('t1', T0, 'A', -10),
    temp('t2', T0 + MIN, 'A', -20),
    ship('s1', T0 + 2 * MIN, 'L1', 'A', T0 - 10_000, T0 + 2 * MIN),
    { type: 'ship', id: 's1', eventTs: T0 + 3 * MIN, lot: 'L1', zone: 'A', start: T0 - 10_000, end: T0 + 2 * MIN, op: 'retract' },
  ];
  const result = analyze(events);
  assert.equal(result.recall.minimalSize, 0);
  assert.equal(result.evidence.length, 0);
});

test('retracting a door open un-explains the window', () => {
  const events = [
    temp('t1', T0, 'B', -8),
    door('d1', T0 + MIN, 'B', true),
    temp('t2', T0 + 5 * MIN, 'B', -20),
    ship('s1', T0 + 6 * MIN, 'L1', 'B', T0 - MIN, T0 + 10 * MIN),
    retract(T0 + 7 * MIN, 'door', 'd1'),
  ];
  const result = analyze(events);
  assert.equal(result.counts.explainedWindows, 0);
  assert.deepEqual(result.recall.solutions, [['L1']]);
});

test('late events (behind watermark) are dropped and logged', () => {
  const events = [
    temp('t1', T0 + 10 * MIN, 'A', -10),
    temp('t2', T0, 'A', -10),
    temp('t3', T0 + 11 * MIN, 'A', -20),
  ];
  const result = analyze(events);
  assert.equal(result.counts.lateEvents, 1);
  assert.equal(result.late[0].event.id, 't2');
  assert.equal(result.counts.tempReadings, 2);
  assert.equal(result.watermark, T0 + 11 * MIN - 2 * MIN);
});

test('temperature outside physical range throws TEMP_RANGE', () => {
  assert.throws(() => [...parseJsonl('{"type":"temp","eventTs":1,"zone":"A","c":-300}')], (err) => {
    assert.ok(err instanceof TempRangeError);
    assert.equal(err.code, 'TEMP_RANGE');
    return true;
  });
  assert.throws(() => [...parseJsonl('{"type":"temp","eventTs":1,"zone":"A","c":150}')], TempRangeError);
});

test('boundary physical temperatures are accepted', () => {
  const events = [...parseJsonl('{"type":"temp","eventTs":1,"zone":"A","c":-273.15}\n{"type":"temp","eventTs":2,"zone":"A","c":100}')];
  assert.equal(events.length, 2);
});

test('invalid JSON and unknown types raise PARSE_ERROR', () => {
  assert.throws(() => [...parseJsonl('{not json}')], ParseError);
  assert.throws(() => [...parseJsonl('{"type":"mystery","eventTs":1}')], ParseError);
  assert.throws(() => [...parseJsonl('{"type":"temp","eventTs":1,"zone":"A"}')], ParseError);
});

test('duplicate ids upsert; anonymous events always kept', () => {
  const events = [
    temp('t1', T0, 'A', -10),
    temp('t1', T0 + 30_000, 'A', -20),
    temp(null, T0 + MIN, 'A', -10),
    temp('t2', T0 + 2 * MIN, 'A', -20),
  ];
  const result = analyze(events);
  assert.equal(result.counts.tempReadings, 3);
});
