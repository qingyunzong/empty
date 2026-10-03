'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { LeaderboardEngine, WINDOW_MS } = require('../src/engine');

// Independent brute-force reference: replays the stream with its own
// acceptance rules, then recomputes every window from scratch and
// enumerates the full leaderboard. Shares no code with src/engine.js.
function referenceModel(events) {
  let watermark = -Infinity;
  const records = new Map();
  const closed = (windowStart) => windowStart + WINDOW_MS <= watermark;

  for (const event of events) {
    if (event.type === 'WATERMARK') {
      if (event.ts > watermark) watermark = event.ts;
      continue;
    }
    const { eventId, version, op } = event;
    const prev = records.get(eventId);
    if (prev && version <= prev.version) continue;
    if (op === 'RETRACT') {
      if (!prev) continue;
      if (prev.op === 'UPSERT' && closed(prev.windowStart)) continue;
      records.set(eventId, { version, op: 'RETRACT' });
      continue;
    }
    if (typeof event.charge !== 'number' || !Number.isFinite(event.charge) || event.charge < 0) {
      continue;
    }
    const windowStart = Math.floor(event.ts / WINDOW_MS) * WINDOW_MS;
    if (closed(windowStart)) continue;
    if (prev && prev.op === 'UPSERT' && closed(prev.windowStart)) continue;
    records.set(eventId, {
      version,
      op: 'UPSERT',
      windowStart,
      channel: event.channel,
      charge: event.charge,
    });
  }

  const windows = new Map();
  for (const [id, record] of records) {
    if (record.op !== 'UPSERT') continue;
    if (!windows.has(record.windowStart)) windows.set(record.windowStart, []);
    windows.get(record.windowStart).push({ id, channel: record.channel, charge: record.charge });
  }

  const boards = new Map();
  for (const [windowStart, windowEvents] of windows) {
    windowEvents.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const totals = {};
    for (const { channel, charge } of windowEvents) {
      totals[channel] = (totals[channel] ?? 0) + charge;
    }
    const full = Object.entries(totals)
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([channel, total]) => ({ channel, total }));
    boards.set(windowStart, {
      full,
      eventIds: windowEvents.map((e) => e.id),
      totals,
    });
  }
  return boards;
}

function engineFinalBoards(events) {
  const engine = new LeaderboardEngine();
  const published = new Map();
  const errors = [];
  for (const event of events) {
    let actions;
    try {
      actions = engine.apply(event);
    } catch (err) {
      errors.push(err.code);
      continue;
    }
    for (const action of actions) {
      if (action.type === 'ADD') {
        published.set(action.window.start, action);
      } else {
        const current = published.get(action.window.start);
        assert.ok(current, `WITHDRAW for window ${action.window.start} without a published board`);
        assert.deepEqual(current.top, action.top, 'WITHDRAW must match the last published board');
        published.delete(action.window.start);
      }
    }
  }
  return { published, finalBoards: engine.finalBoards, errors };
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomStream(seed, size) {
  const rand = makeRng(seed);
  const channels = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
  const events = [];
  let watermarkTs = 0;
  for (let i = 0; i < size; i += 1) {
    if (rand() < 0.15) {
      watermarkTs += Math.floor(rand() * 2 * WINDOW_MS);
      events.push({ type: 'WATERMARK', ts: watermarkTs });
      continue;
    }
    const eventId = `e${Math.floor(rand() * 10)}`;
    const version = 1 + Math.floor(rand() * 6);
    if (rand() < 0.2) {
      events.push({ type: 'TRIGGER', eventId, version, op: 'RETRACT' });
      continue;
    }
    let charge = Math.floor(rand() * 51);
    if (rand() < 0.05) charge = -1;
    if (rand() < 0.05) charge = Number.NaN;
    events.push({
      type: 'TRIGGER',
      eventId,
      version,
      op: 'UPSERT',
      channel: channels[Math.floor(rand() * channels.length)],
      ts: Math.floor(rand() * 3 * WINDOW_MS),
      charge,
    });
  }
  return events;
}

test('engine matches the brute-force reference on randomized streams', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const events = randomStream(seed, 60);
    const reference = referenceModel(events);
    const { published, finalBoards } = engineFinalBoards(events);

    assert.deepEqual(
      [...published.keys()].sort((a, b) => a - b),
      [...reference.keys()].sort((a, b) => a - b),
      `window set mismatch for seed ${seed}`,
    );

    for (const [windowStart, expected] of reference) {
      const actual = published.get(windowStart);
      assert.ok(actual, `missing published board for window ${windowStart} (seed ${seed})`);
      assert.deepEqual(actual.top, expected.full.slice(0, 3), `top3 mismatch (seed ${seed})`);
      assert.deepEqual(
        Object.keys(actual.certificate.totals).sort(),
        Object.keys(expected.totals).sort(),
      );
      for (const [channel, total] of Object.entries(expected.totals)) {
        assert.equal(actual.certificate.totals[channel], total, `total mismatch for ${channel}`);
      }
      assert.deepEqual(actual.certificate.eventIds, expected.eventIds);
    }

    for (const [windowStart, board] of finalBoards) {
      const live = published.get(windowStart);
      assert.ok(live, `sealed board for window ${windowStart} was never published`);
      assert.deepEqual(board.top, live.top);
      assert.deepEqual(board.certificate, live.certificate);
    }
  }
});

test('reference certificate sums are independently reconstructable from raw events', () => {
  const rand = makeRng(7);
  const channels = ['alpha', 'beta', 'gamma'];
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push({
      type: 'TRIGGER',
      eventId: `u${i}`,
      version: 1,
      op: 'UPSERT',
      channel: channels[Math.floor(rand() * channels.length)],
      ts: Math.floor(rand() * 2 * WINDOW_MS),
      charge: Math.floor(rand() * 20),
    });
  }
  const reference = referenceModel(events);
  for (const [, board] of reference) {
    const totalSum = Object.values(board.totals).reduce((a, b) => a + b, 0);
    const eventSum = events
      .filter((e) => board.eventIds.includes(e.eventId))
      .reduce((sum, e) => sum + e.charge, 0);
    assert.equal(totalSum, eventSum);
  }
});
