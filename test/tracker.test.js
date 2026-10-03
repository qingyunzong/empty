'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TrackEngine } = require('../src/tracker');

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

function plan(flightId, version, polygon = SQUARE, start = 0, end = 200) {
  return { type: 'FLIGHT_PLAN', flightId, start, end, polygon, version };
}

function obs(obsId, ts, x, y) {
  return { type: 'GROUND_OBSERVATION', obsId, ts, x, y };
}

function types(actions) {
  return actions.map((a) => a.type);
}

test('acceptance: late-arriving plan matches previously unmatched observation', () => {
  const engine = new TrackEngine();
  assert.deepEqual(types(engine.process(obs('O1', 100, 5, 5))), ['UNMATCHED']);
  const actions = engine.process(plan('F1', 1));
  assert.deepEqual(types(actions), ['PLAN_ACCEPTED', 'MATCH']);
  assert.equal(actions[1].obsId, 'O1');
  assert.equal(actions[1].flightId, 'F1');
  const certs = engine.process({ type: 'WATERMARK', ts: 106 });
  assert.deepEqual(types(certs), ['CERTIFICATE']);
  assert.equal(certs[0].matched, true);
  assert.equal(certs[0].flightId, 'F1');
});

test('acceptance: polygon shrink unmatches boundary observation and cascades WITHDRAW', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1));
  const matched = engine.process(obs('O1', 50, 10, 5));
  assert.deepEqual(types(matched), ['MATCH']);
  const shrunk = [
    [0, 0],
    [8, 0],
    [8, 8],
    [0, 8],
  ];
  const actions = engine.process(plan('F1', 2, shrunk));
  assert.deepEqual(types(actions), ['PLAN_ACCEPTED', 'WITHDRAW', 'UNMATCHED']);
  assert.equal(actions[1].obsId, 'O1');
  assert.equal(actions[1].flightId, 'F1');
  assert.equal(actions[2].obsId, 'O1');
});

test('acceptance: overlapping plans select lexicographically smallest flightId stably', () => {
  for (const order of [
    ['FB', 'FA'],
    ['FA', 'FB'],
  ]) {
    const engine = new TrackEngine();
    for (const id of order) engine.process(plan(id, 1));
    const actions = engine.process(obs('O1', 50, 5, 5));
    assert.deepEqual(types(actions), ['MATCH']);
    assert.equal(actions[0].flightId, 'FA');
  }
});

test('retract cascades WITHDRAW and re-matches to next best plan', () => {
  const engine = new TrackEngine();
  engine.process(plan('FA', 1));
  engine.process(plan('FB', 1));
  engine.process(obs('O1', 50, 5, 5));
  const actions = engine.process({ type: 'RETRACT', flightId: 'FA' });
  assert.deepEqual(types(actions), ['PLAN_RETRACTED', 'WITHDRAW', 'MATCH']);
  assert.equal(actions[1].flightId, 'FA');
  assert.equal(actions[2].flightId, 'FB');
});

test('retract of only plan leaves observation unmatched', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1));
  engine.process(obs('O1', 50, 5, 5));
  const actions = engine.process({ type: 'RETRACT', flightId: 'F1' });
  assert.deepEqual(types(actions), ['PLAN_RETRACTED', 'WITHDRAW', 'UNMATCHED']);
});

test('stale and equal versions are rejected with STALE_VERSION', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 2));
  const lower = engine.process(plan('F1', 1));
  assert.deepEqual(types(lower), ['STALE_VERSION']);
  const equal = engine.process(plan('F1', 2));
  assert.deepEqual(types(equal), ['STALE_VERSION']);
  assert.equal(engine.plans.get('F1').version, 2);
});

test('modification after publication reports LATE', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1));
  engine.process(obs('O1', 50, 5, 5));
  engine.process({ type: 'WATERMARK', ts: 100 });
  const corrected = engine.process(plan('F1', 2));
  assert.deepEqual(types(corrected), ['LATE']);
  const retracted = engine.process({ type: 'RETRACT', flightId: 'F1' });
  assert.deepEqual(types(retracted), ['LATE']);
  assert.equal(engine.plans.get('F1').version, 1);
});

test('new plan covering published observations is LATE', () => {
  const engine = new TrackEngine();
  engine.process(obs('O1', 50, 5, 5));
  engine.process({ type: 'WATERMARK', ts: 100 });
  const actions = engine.process(plan('F9', 1));
  assert.deepEqual(types(actions), ['LATE']);
});

test('watermark publishes only observations older than 5 time units', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1));
  engine.process(obs('O1', 10, 5, 5));
  engine.process(obs('O2', 14, 5, 5));
  engine.process(obs('O3', 16, 5, 5));
  const certs = engine.process({ type: 'WATERMARK', ts: 20 });
  assert.deepEqual(types(certs), ['CERTIFICATE', 'CERTIFICATE']);
  assert.deepEqual(certs.map((c) => c.obsId), ['O1', 'O2']);
  assert.equal(engine.buffered.size, 1);
  const rest = engine.process({ type: 'WATERMARK', ts: 21 });
  assert.deepEqual(rest.map((c) => c.obsId), ['O3']);
});

test('out-of-order observations before watermark publish in ts order', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1));
  engine.process(obs('O2', 12, 5, 5));
  engine.process(obs('O1', 10, 5, 5));
  const certs = engine.process({ type: 'WATERMARK', ts: 20 });
  assert.deepEqual(certs.map((c) => c.obsId), ['O1', 'O2']);
});

test('observation outside time window does not match', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1, SQUARE, 10, 20));
  assert.deepEqual(types(engine.process(obs('O1', 20, 5, 5))), ['UNMATCHED']);
  assert.deepEqual(types(engine.process(obs('O2', 9, 5, 5))), ['UNMATCHED']);
  assert.deepEqual(types(engine.process(obs('O3', 10, 5, 5))), ['MATCH']);
});

test('INVALID_POLYGON for fewer than 3 vertices', () => {
  const engine = new TrackEngine();
  const actions = engine.process(plan('F1', 1, [[0, 0], [1, 1]]));
  assert.deepEqual(types(actions), ['INVALID_POLYGON']);
});

test('MALFORMED for non-numeric coordinates', () => {
  const engine = new TrackEngine();
  const badPlan = engine.process(plan('F1', 1, [[0, 0], ['x', 1], [1, 0]]));
  assert.deepEqual(types(badPlan), ['MALFORMED']);
  const badObs = engine.process({ type: 'GROUND_OBSERVATION', obsId: 'O1', ts: 1, x: 'a', y: 2 });
  assert.deepEqual(types(badObs), ['MALFORMED']);
});

test('UNKNOWN_RETRACT for unknown flightId', () => {
  const engine = new TrackEngine();
  const actions = engine.process({ type: 'RETRACT', flightId: 'NOPE' });
  assert.deepEqual(types(actions), ['UNKNOWN_RETRACT']);
});

test('finish flushes remaining buffered observations as certificates', () => {
  const engine = new TrackEngine();
  engine.process(plan('F1', 1));
  engine.process(obs('O1', 1, 5, 5));
  engine.process(obs('O2', 2, 50, 50));
  const certs = engine.finish();
  assert.deepEqual(types(certs), ['CERTIFICATE', 'CERTIFICATE']);
  assert.equal(certs[0].matched, true);
  assert.equal(certs[1].matched, false);
});
