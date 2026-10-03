'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LeaderboardEngine, WINDOW_MS } = require('../src/engine');

function upsert(eventId, version, channel, ts, charge) {
  return { type: 'TRIGGER', eventId, version, op: 'UPSERT', channel, ts, charge };
}

function retract(eventId, version) {
  return { type: 'TRIGGER', eventId, version, op: 'RETRACT' };
}

function watermark(ts) {
  return { type: 'WATERMARK', ts };
}

test('out-of-order large charges replace the top of the board repeatedly before close', () => {
  const engine = new LeaderboardEngine();
  const actions = [];
  const feed = (event) => actions.push(...engine.apply(event));

  feed(upsert('e1', 1, 'alpha', 500_000, 10));
  feed(upsert('e2', 1, 'beta', 100, 60));
  feed(upsert('e3', 1, 'gamma', 300_000, 120));
  feed(upsert('e4', 1, 'delta', 50, 300));

  const adds = actions.filter((a) => a.type === 'ADD');
  assert.deepEqual(adds.map((a) => a.top[0].channel), ['alpha', 'beta', 'gamma', 'delta']);
  assert.deepEqual(adds.map((a) => a.top[0].total), [10, 60, 120, 300]);

  for (let i = 1; i < adds.length; i += 1) {
    const index = actions.indexOf(adds[i]);
    assert.equal(actions[index - 1].type, 'WITHDRAW');
    assert.deepEqual(actions[index - 1].top, adds[i - 1].top);
    assert.deepEqual(actions[index - 1].certificate, adds[i - 1].certificate);
  }
  assert.equal(actions[0].type, 'ADD');
  assert.deepEqual(actions[0].window, { start: 0, end: WINDOW_MS });
});

test('higher version upsert incrementally corrects the ranking', () => {
  const engine = new LeaderboardEngine();
  const first = engine.apply(upsert('e1', 1, 'alpha', 10, 5));
  assert.deepEqual(first[0].top, [{ channel: 'alpha', total: 5 }]);

  const second = engine.apply(upsert('e1', 2, 'alpha', 10, 9));
  assert.equal(second[0].type, 'WITHDRAW');
  assert.deepEqual(second[0].top, [{ channel: 'alpha', total: 5 }]);
  assert.equal(second[1].type, 'ADD');
  assert.deepEqual(second[1].top, [{ channel: 'alpha', total: 9 }]);
  assert.deepEqual(second[1].certificate.eventIds, ['e1']);
  assert.deepEqual(second[1].certificate.totals, { alpha: 9 });
});

test('ties in the top three are ordered lexicographically and the certificate is independently verifiable', () => {
  const engine = new LeaderboardEngine();
  const events = [
    upsert('t1', 1, 'delta', 1, 10),
    upsert('t2', 1, 'alpha', 2, 15),
    upsert('t3', 1, 'charlie', 3, 20),
    upsert('t4', 1, 'bravo', 4, 30),
    upsert('t5', 1, 'delta', 5, 20),
    upsert('t6', 1, 'alpha', 6, 15),
    upsert('t7', 1, 'charlie', 7, 10),
    upsert('t8', 1, 'echo', 8, 29),
  ];
  let lastActions = [];
  for (const event of events) lastActions = engine.apply(event);

  const board = lastActions.filter((a) => a.type === 'ADD').pop();
  assert.deepEqual(
    board.top.map((e) => e.channel),
    ['alpha', 'bravo', 'charlie'],
  );
  assert.deepEqual(
    board.top.map((e) => e.total),
    [30, 30, 30],
  );

  const expectedTotals = {};
  const expectedIds = [];
  for (const event of events) {
    expectedTotals[event.channel] = (expectedTotals[event.channel] ?? 0) + event.charge;
    expectedIds.push(event.eventId);
  }
  expectedIds.sort();
  assert.deepEqual(board.certificate.totals, expectedTotals);
  assert.deepEqual(board.certificate.eventIds, expectedIds);
  const certificateSum = Object.values(board.certificate.totals).reduce((a, b) => a + b, 0);
  assert.equal(certificateSum, events.reduce((sum, e) => sum + e.charge, 0));
});

test('window closes when the watermark reaches its end; late events and retracts are rejected', () => {
  const engine = new LeaderboardEngine();
  const actions = engine.apply(upsert('e1', 1, 'alpha', 100, 5));
  assert.equal(actions.length, 1);
  const published = actions[0];

  assert.deepEqual(engine.apply(watermark(WINDOW_MS)), []);
  assert.deepEqual(engine.finalBoards.get(0), {
    top: published.top,
    certificate: published.certificate,
  });

  assert.throws(
    () => engine.apply(retract('e1', 2)),
    (err) => err.code === 'LATE',
  );
  assert.throws(
    () => engine.apply(upsert('e2', 1, 'beta', 200, 7)),
    (err) => err.code === 'LATE',
  );
  assert.throws(
    () => engine.apply(upsert('e1', 2, 'alpha', 300, 9)),
    (err) => err.code === 'LATE',
  );

  assert.deepEqual(engine.finalBoards.get(0), {
    top: published.top,
    certificate: published.certificate,
  });

  const nextWindow = engine.apply(upsert('e3', 1, 'beta', WINDOW_MS + 1, 3));
  assert.equal(nextWindow[0].type, 'ADD');
  assert.deepEqual(nextWindow[0].window, { start: WINDOW_MS, end: 2 * WINDOW_MS });
});

test('retract before close withdraws the board and a higher version can re-upsert', () => {
  const engine = new LeaderboardEngine();
  engine.apply(upsert('e1', 1, 'alpha', 10, 5));
  engine.apply(upsert('e2', 1, 'beta', 20, 8));

  const retractActions = engine.apply(retract('e2', 2));
  assert.equal(retractActions[0].type, 'WITHDRAW');
  assert.deepEqual(retractActions[0].top, [
    { channel: 'beta', total: 8 },
    { channel: 'alpha', total: 5 },
  ]);
  assert.equal(retractActions[1].type, 'ADD');
  assert.deepEqual(retractActions[1].top, [{ channel: 'alpha', total: 5 }]);
  assert.deepEqual(retractActions[1].certificate.eventIds, ['e1']);

  const reAdd = engine.apply(upsert('e2', 3, 'beta', 20, 8));
  assert.equal(reAdd[0].type, 'WITHDRAW');
  assert.equal(reAdd[1].type, 'ADD');
  assert.deepEqual(reAdd[1].certificate.eventIds, ['e1', 'e2']);
});

test('retracting the last event withdraws the board without adding an empty one', () => {
  const engine = new LeaderboardEngine();
  engine.apply(upsert('e1', 1, 'alpha', 10, 5));
  const actions = engine.apply(retract('e1', 2));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'WITHDRAW');
});

test('stale versions are rejected for upserts and retracts', () => {
  const engine = new LeaderboardEngine();
  engine.apply(upsert('e1', 5, 'alpha', 10, 5));
  assert.throws(
    () => engine.apply(upsert('e1', 4, 'alpha', 10, 6)),
    (err) => err.code === 'STALE_VERSION',
  );
  assert.throws(
    () => engine.apply(upsert('e1', 5, 'alpha', 10, 6)),
    (err) => err.code === 'STALE_VERSION',
  );
  assert.throws(
    () => engine.apply(retract('e1', 5)),
    (err) => err.code === 'STALE_VERSION',
  );
  const actions = engine.apply(retract('e1', 6));
  assert.equal(actions[0].type, 'WITHDRAW');
});

test('retracting an unknown event is rejected', () => {
  const engine = new LeaderboardEngine();
  assert.throws(
    () => engine.apply(retract('nope', 1)),
    (err) => err.code === 'UNKNOWN_RETRACT',
  );
});

test('charge must be a finite non-negative number', () => {
  const engine = new LeaderboardEngine();
  for (const charge of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '5', null]) {
    assert.throws(
      () => engine.apply(upsert('e1', 1, 'alpha', 10, charge)),
      (err) => err.code === 'INVALID_CHARGE',
    );
  }
  const ok = engine.apply(upsert('e1', 1, 'alpha', 10, 0));
  assert.equal(ok[0].type, 'ADD');
  assert.deepEqual(ok[0].top, [{ channel: 'alpha', total: 0 }]);
});

test('malformed events are rejected', () => {
  const engine = new LeaderboardEngine();
  assert.throws(() => engine.apply(null), (err) => err.code === 'INVALID_EVENT');
  assert.throws(() => engine.apply({ type: 'NOPE' }), (err) => err.code === 'INVALID_EVENT');
  assert.throws(
    () => engine.apply({ type: 'TRIGGER', eventId: 'e1', version: 1, op: 'DELETE' }),
    (err) => err.code === 'INVALID_EVENT',
  );
  assert.throws(
    () => engine.apply({ type: 'WATERMARK', ts: -1 }),
    (err) => err.code === 'INVALID_EVENT',
  );
});

test('watermark exactly at window end closes; one ms before does not', () => {
  const engine = new LeaderboardEngine();
  engine.apply(watermark(WINDOW_MS - 1));
  const ok = engine.apply(upsert('e1', 1, 'alpha', WINDOW_MS - 1, 1));
  assert.equal(ok[0].type, 'ADD');
  engine.apply(watermark(WINDOW_MS));
  assert.throws(
    () => engine.apply(upsert('e2', 1, 'alpha', WINDOW_MS - 1, 1)),
    (err) => err.code === 'LATE',
  );
});
