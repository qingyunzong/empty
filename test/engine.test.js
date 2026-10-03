'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, WINDOW_MS } = require('../src/engine');

function upsert(eventId, version, channel, ts, charge) {
  return { type: 'TRIGGER', eventId, version, op: 'UPSERT', channel, ts, charge };
}
function retract(eventId, version) {
  return { type: 'TRIGGER', eventId, version, op: 'RETRACT' };
}
function watermark(ts) {
  return { type: 'WATERMARK', ts };
}

test('acceptance: out-of-order big-charge events replace the top rank repeatedly before close', () => {
  const engine = new Engine();
  const all = [];
  // ts deliberately out of order; charges escalate so the leader keeps changing
  const feed = [
    upsert('e1', 1, 'alpha', 5000, 10),
    upsert('e2', 1, 'beta', 1000, 50),
    upsert('e3', 1, 'gamma', 4000, 200),
    upsert('e4', 1, 'delta', 500, 1000),
  ];
  for (const rec of feed) {
    const { actions, errors } = engine.apply(rec);
    assert.deepEqual(errors, []);
    all.push(...actions);
  }
  const adds = all.filter((a) => a.type === 'ADD');
  assert.equal(adds.length, 4);
  assert.deepEqual(
    adds.map((a) => a.top3[0].channel),
    ['alpha', 'beta', 'gamma', 'delta']
  );
  // every leader change after the first is WITHDRAW(old) then ADD(new)
  assert.equal(all[0].type, 'ADD');
  for (let i = 1; i < all.length; i += 2) {
    assert.equal(all[i].type, 'WITHDRAW');
    assert.equal(all[i + 1].type, 'ADD');
    assert.deepEqual(all[i].top3, adds[Math.floor(i / 2)].top3);
  }
  // all within the same open window
  for (const a of all) {
    assert.equal(a.windowStart, 0);
    assert.equal(a.windowEnd, WINDOW_MS);
  }
});

test('acceptance: ties in top-3 break by lexicographic channel order; certificate sums verifiable', () => {
  const engine = new Engine();
  const log = [
    upsert('e1', 1, 'delta', 10, 6),
    upsert('e2', 1, 'alpha', 20, 4),
    upsert('e3', 1, 'charlie', 30, 10),
    upsert('e4', 1, 'bravo', 40, 3),
    upsert('e5', 1, 'delta', 50, 4),
    upsert('e6', 1, 'alpha', 60, 6),
    upsert('e7', 1, 'bravo', 70, 7),
  ];
  let last;
  for (const rec of log) {
    const { actions, errors } = engine.apply(rec);
    assert.deepEqual(errors, []);
    if (actions.length) last = actions[actions.length - 1];
  }
  // alpha=10, bravo=10, charlie=10, delta=10 -> lexicographic tie-break
  assert.deepEqual(
    last.top3.map((t) => t.channel),
    ['alpha', 'bravo', 'charlie']
  );
  for (const t of last.top3) assert.equal(t.total, 10);

  // independent recomputation of certificate sums straight from the log
  const expected = {};
  const ids = [];
  for (const rec of log) {
    expected[rec.channel] = (expected[rec.channel] || 0) + rec.charge;
    ids.push(rec.eventId);
  }
  assert.deepEqual(last.certificate.channels, Object.fromEntries(
    Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1))
  ));
  assert.deepEqual(last.certificate.eventIds, ids.sort());
  assert.equal(last.certificate.windowStart, 0);
  assert.equal(last.certificate.windowEnd, WINDOW_MS);
});

test('acceptance: retract after window close is rejected and the published ranking is unchanged', () => {
  const engine = new Engine();
  engine.apply(upsert('e1', 1, 'alpha', 100, 5));
  engine.apply(upsert('e2', 1, 'beta', 200, 9));
  const { actions: before } = engine.apply(upsert('e3', 1, 'gamma', 300, 7));
  const published = before[before.length - 1];

  engine.apply(watermark(WINDOW_MS)); // closes window [0, 600000)

  const { actions, errors } = engine.apply(retract('e2', 2));
  assert.equal(actions.length, 0);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error, 'LATE');
  assert.equal(errors[0].eventId, 'e2');

  // late upserts into the closed window are rejected too
  const late = engine.apply(upsert('e9', 1, 'omega', 400, 1000));
  assert.equal(late.errors[0].error, 'LATE');
  assert.equal(late.actions.length, 0);

  // stored ranking untouched
  const w = engine.windows.get(0);
  assert.equal(w.closed, true);
  assert.deepEqual(w.published, {
    windowStart: published.windowStart,
    windowEnd: published.windowEnd,
    top3: published.top3,
    certificate: published.certificate,
  });
});

test('retract before close incrementally fixes the ranking', () => {
  const engine = new Engine();
  engine.apply(upsert('e1', 1, 'alpha', 100, 100));
  engine.apply(upsert('e2', 1, 'beta', 200, 50));
  const { actions, errors } = engine.apply(retract('e1', 2));
  assert.deepEqual(errors, []);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].type, 'WITHDRAW');
  assert.deepEqual(actions[0].top3.map((t) => t.channel), ['alpha', 'beta']);
  assert.equal(actions[1].type, 'ADD');
  assert.deepEqual(actions[1].top3, [{ channel: 'beta', total: 50 }]);
  assert.deepEqual(actions[1].certificate.eventIds, ['e2']);
  assert.deepEqual(actions[1].certificate.channels, { beta: 50 });
});

test('higher version upsert overrides; lower/equal version reports STALE_VERSION', () => {
  const engine = new Engine();
  engine.apply(upsert('e1', 5, 'alpha', 100, 10));
  const stale = engine.apply(upsert('e1', 4, 'alpha', 100, 999));
  assert.equal(stale.errors[0].error, 'STALE_VERSION');
  assert.equal(stale.actions.length, 0);
  const equal = engine.apply(upsert('e1', 5, 'alpha', 100, 999));
  assert.equal(equal.errors[0].error, 'STALE_VERSION');

  const { actions, errors } = engine.apply(upsert('e1', 6, 'beta', 100, 1));
  assert.deepEqual(errors, []);
  const add = actions.find((a) => a.type === 'ADD');
  assert.deepEqual(add.top3, [{ channel: 'beta', total: 1 }]);
  assert.deepEqual(add.certificate.channels, { beta: 1 });
});

test('retract of unknown event reports UNKNOWN_RETRACT', () => {
  const engine = new Engine();
  const { actions, errors } = engine.apply(retract('nope', 1));
  assert.equal(actions.length, 0);
  assert.equal(errors[0].error, 'UNKNOWN_RETRACT');
  assert.equal(errors[0].eventId, 'nope');
  // retracting twice: second one is unknown again
  engine.apply(upsert('e1', 1, 'a', 1, 1));
  engine.apply(retract('e1', 2));
  const again = engine.apply(retract('e1', 3));
  assert.equal(again.errors[0].error, 'UNKNOWN_RETRACT');
});

test('charge must be finite and non-negative', () => {
  const engine = new Engine();
  for (const bad of [-1, NaN, Infinity, -Infinity, '5', null]) {
    const { actions, errors } = engine.apply(upsert('e1', 1, 'a', 1, bad));
    assert.equal(actions.length, 0);
    assert.equal(errors[0].error, 'INVALID_CHARGE', `charge=${bad}`);
  }
  const ok = engine.apply(upsert('e1', 1, 'a', 1, 0));
  assert.deepEqual(ok.errors, []);
});

test('windows are 10-minute tumbling windows keyed by event time', () => {
  const engine = new Engine();
  engine.apply(upsert('e1', 1, 'a', 0, 1));
  engine.apply(upsert('e2', 1, 'b', WINDOW_MS - 1, 2));
  const { actions } = engine.apply(upsert('e3', 1, 'c', WINDOW_MS, 3));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].windowStart, WINDOW_MS);
  assert.equal(actions[0].windowEnd, 2 * WINDOW_MS);
  assert.deepEqual(actions[0].top3, [{ channel: 'c', total: 3 }]);
});

test('watermark exactly at window end closes it; one ms before does not', () => {
  const engine = new Engine();
  engine.apply(upsert('e1', 1, 'a', 0, 1));
  engine.apply(watermark(WINDOW_MS - 1));
  const stillOpen = engine.apply(upsert('e2', 1, 'b', 1, 2));
  assert.deepEqual(stillOpen.errors, []);
  engine.apply(watermark(WINDOW_MS));
  const closed = engine.apply(upsert('e3', 1, 'c', 2, 3));
  assert.equal(closed.errors[0].error, 'LATE');
});

test('emptying a window withdraws the ranking without a new ADD', () => {
  const engine = new Engine();
  engine.apply(upsert('e1', 1, 'a', 0, 1));
  const { actions } = engine.apply(retract('e1', 2));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, 'WITHDRAW');
  assert.deepEqual(actions[0].top3, [{ channel: 'a', total: 1 }]);
});

test('invalid records and bad watermarks are reported', () => {
  const engine = new Engine();
  assert.equal(engine.apply(null).errors[0].error, 'INVALID_EVENT');
  assert.equal(engine.apply({ type: 'NOPE' }).errors[0].error, 'INVALID_EVENT');
  assert.equal(engine.apply({ type: 'WATERMARK', ts: 'x' }).errors[0].error, 'INVALID_WATERMARK');
  assert.equal(engine.apply({ type: 'TRIGGER', eventId: '', version: 1, op: 'UPSERT', channel: 'a', ts: 0, charge: 1 }).errors[0].error, 'INVALID_EVENT');
  assert.equal(engine.apply({ type: 'TRIGGER', eventId: 'e', version: 1, op: 'DELETE' }).errors[0].error, 'INVALID_EVENT');
});
