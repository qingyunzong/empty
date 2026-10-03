'use strict';

// Differential test: the engine (incremental) is compared against an
// independently written brute-force reference that replays the whole log,
// sums every window from scratch, sorts and enumerates the full ranking.
// The reference deliberately shares no code with src/engine.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');

const W = 10 * 60 * 1000;

function referenceRun(records) {
  const versions = new Map();
  const live = new Map(); // eventId -> { ws, channel, charge, version }
  let wm = null;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'WATERMARK') {
      if (typeof rec.ts === 'number' && Number.isFinite(rec.ts) && (wm === null || rec.ts > wm)) wm = rec.ts;
      continue;
    }
    if (rec.type !== 'TRIGGER') continue;
    const { eventId, version, op } = rec;
    if (typeof eventId !== 'string' || typeof version !== 'number') continue;
    if (op === 'UPSERT') {
      if (typeof rec.channel !== 'string' || typeof rec.ts !== 'number') continue;
      if (typeof rec.charge !== 'number' || !Number.isFinite(rec.charge) || rec.charge < 0) continue;
      const ws = Math.floor(rec.ts / W) * W;
      if (wm !== null && ws + W <= wm) continue; // LATE
      if (versions.has(eventId) && version <= versions.get(eventId)) continue; // STALE
      versions.set(eventId, version);
      live.set(eventId, { ws, channel: rec.channel, charge: rec.charge, version });
    } else if (op === 'RETRACT') {
      const prev = live.get(eventId);
      if (!prev) continue; // UNKNOWN_RETRACT
      if (wm !== null && prev.ws + W <= wm) continue; // LATE
      if (version <= prev.version) continue; // STALE
      versions.set(eventId, version);
      live.delete(eventId);
    }
  }
  // brute force: group live events by window, sum every window from scratch
  const byWindow = new Map();
  for (const [eventId, ev] of live) {
    if (!byWindow.has(ev.ws)) byWindow.set(ev.ws, []);
    byWindow.get(ev.ws).push({ eventId, ...ev });
  }
  const out = new Map();
  for (const [ws, evs] of byWindow) {
    const sums = {};
    for (const ev of evs) sums[ev.channel] = (sums[ev.channel] || 0) + ev.charge;
    const full = Object.entries(sums)
      .sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : 1))
      .map(([channel, total]) => ({ channel, total }));
    out.set(ws, {
      full,
      eventIds: evs.map((e) => e.eventId).sort(),
      channels: sums,
    });
  }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLog(rand, nEvents) {
  const records = [];
  const channels = Array.from({ length: 8 }, (_, i) => `ch${i}`);
  let idCounter = 0;
  const issued = []; // {eventId, version}
  for (let i = 0; i < nEvents; i++) {
    const roll = rand();
    if (roll < 0.08) {
      records.push({ type: 'WATERMARK', ts: (1 + Math.floor(rand() * 4)) * W });
    } else if (roll < 0.25 && issued.length > 0) {
      const target = issued[Math.floor(rand() * issued.length)];
      if (rand() < 0.5) {
        records.push({ type: 'TRIGGER', eventId: target.eventId, version: target.version + 1, op: 'RETRACT' });
      } else {
        target.version += 1 + Math.floor(rand() * 2);
        records.push({
          type: 'TRIGGER', eventId: target.eventId, version: target.version, op: 'UPSERT',
          channel: channels[Math.floor(rand() * channels.length)],
          ts: Math.floor(rand() * 4 * W),
          charge: Math.round(rand() * 10000) / 100,
        });
      }
    } else if (roll < 0.32 && issued.length > 0) {
      // stale version on purpose
      const target = issued[Math.floor(rand() * issued.length)];
      records.push({
        type: 'TRIGGER', eventId: target.eventId, version: Math.max(0, target.version - 1), op: 'UPSERT',
        channel: channels[Math.floor(rand() * channels.length)],
        ts: Math.floor(rand() * 4 * W),
        charge: Math.round(rand() * 100),
      });
    } else {
      const eventId = `ev${idCounter++}`;
      const version = 1 + Math.floor(rand() * 3);
      issued.push({ eventId, version });
      records.push({
        type: 'TRIGGER', eventId, version, op: 'UPSERT',
        channel: channels[Math.floor(rand() * channels.length)],
        ts: Math.floor(rand() * 4 * W),
        charge: Math.round(rand() * 10000) / 100,
      });
    }
  }
  records.push({ type: 'WATERMARK', ts: 4 * W }); // close everything
  return records;
}

function finalRankings(records) {
  // replay the engine's action stream to obtain the final published ranking
  // per window, validating the WITHDRAW/ADD protocol along the way
  const engine = new Engine();
  const published = new Map();
  for (const rec of records) {
    const { actions } = engine.apply(rec);
    for (const action of actions) {
      if (action.type === 'WITHDRAW') {
        const cur = published.get(action.windowStart);
        assert.ok(cur, 'WITHDRAW without a published ranking');
        assert.deepEqual(
          { top3: cur.top3, certificate: cur.certificate },
          { top3: action.top3, certificate: action.certificate },
          'WITHDRAW must carry the previously published ranking'
        );
        published.delete(action.windowStart);
      } else {
        published.set(action.windowStart, action);
      }
    }
  }
  return published;
}

function assertClose(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${msg}: ${actual} != ${expected}`);
}

for (const seed of [1, 7, 42, 1337, 20261003]) {
  test(`differential: engine matches brute-force reference (seed=${seed})`, () => {
    const rand = mulberry32(seed);
    const records = randomLog(rand, 400);
    const expected = referenceRun(records);
    const actual = finalRankings(records);

    assert.equal(actual.size, expected.size, 'same set of non-empty windows');
    for (const [ws, exp] of expected) {
      const act = actual.get(ws);
      assert.ok(act, `window ${ws} published`);
      assert.equal(act.windowEnd, ws + W);

      // top-3 of the engine equals the head of the fully enumerated ranking
      const expTop = exp.full.slice(0, 3);
      assert.equal(act.top3.length, expTop.length);
      for (let i = 0; i < expTop.length; i++) {
        assert.equal(act.top3[i].channel, expTop[i].channel, `window ${ws} rank ${i}`);
        assertClose(act.top3[i].total, expTop[i].total, `window ${ws} rank ${i} total`);
      }

      // certificate: all participating ids and every channel sum
      assert.deepEqual(act.certificate.eventIds, exp.eventIds);
      const actChannels = Object.keys(act.certificate.channels).sort();
      assert.deepEqual(actChannels, Object.keys(exp.channels).sort());
      for (const ch of actChannels) {
        assertClose(act.certificate.channels[ch], exp.channels[ch], `window ${ws} channel ${ch}`);
      }
    }
  });
}

test('differential: small deterministic log with ties and retracts', () => {
  const records = [
    { type: 'TRIGGER', eventId: 'a1', version: 1, op: 'UPSERT', channel: 'x', ts: 5, charge: 2.5 },
    { type: 'TRIGGER', eventId: 'a2', version: 1, op: 'UPSERT', channel: 'y', ts: 6, charge: 2.5 },
    { type: 'TRIGGER', eventId: 'a3', version: 1, op: 'UPSERT', channel: 'z', ts: 7, charge: 2.5 },
    { type: 'TRIGGER', eventId: 'a4', version: 1, op: 'UPSERT', channel: 'w', ts: 8, charge: 2.5 },
    { type: 'TRIGGER', eventId: 'a1', version: 2, op: 'RETRACT' },
    { type: 'TRIGGER', eventId: 'a2', version: 2, op: 'UPSERT', channel: 'w', ts: 9, charge: 0.5 },
    { type: 'WATERMARK', ts: W },
  ];
  const expected = referenceRun(records);
  const actual = finalRankings(records);
  const exp = expected.get(0);
  const act = actual.get(0);
  assert.deepEqual(act.top3.map((t) => t.channel), exp.full.slice(0, 3).map((t) => t.channel));
  // a2 v2 moves its charge from y to w, a1 is retracted: w=3, z=2.5, y has nothing left
  assert.deepEqual(act.top3.map((t) => t.channel), ['w', 'z']);
  assert.deepEqual(act.certificate.eventIds, ['a2', 'a3', 'a4']);
});
