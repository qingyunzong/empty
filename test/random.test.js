'use strict';
// Acceptance 4: random small-set enumeration — incremental (differentially
// maintained) state must match a full from-scratch recompute after every event.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, applyEvent, reports } = require('../src/engine');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATES = ['2026-10-05', '2026-10-06', '2026-10-07'];
const PAIRS = ['EUR/USD', 'USD/JPY'];
const CCYS = ['EUR', 'USD', 'JPY'];

function genEvents(seed, n) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const events = [];
  const ids = [];
  let calVersion = 0;
  for (let i = 0; i < n; i++) {
    const r = rnd();
    if (r < 0.35 || ids.length === 0) {
      const id = 'T' + i;
      ids.push(id);
      const d = pick(DATES);
      events.push({
        type: 'trade', id, pair: pick(PAIRS),
        amount: 10 + Math.floor(rnd() * 90), rate: 1 + Math.floor(rnd() * 3),
        valueDate: d, maturity: d + 'T' + String(8 + Math.floor(rnd() * 8)).padStart(2, '0') + ':00:00Z',
      });
    } else if (r < 0.55) {
      events.push({ type: 'liquidity', ccy: pick(CCYS), date: pick(DATES), amount: Math.floor(rnd() * 200) });
    } else if (r < 0.7) {
      const id = pick(ids);
      events.push(rnd() < 0.5
        ? { type: 'cancel', id }
        : { type: 'cancel', id, amount: 1 + Math.floor(rnd() * 100) });
    } else if (r < 0.82) {
      events.push({ type: 'delay', id: pick(ids), valueDate: pick(DATES) });
    } else if (r < 0.92) {
      events.push({ type: 'reprice', id: pick(ids), rate: 1 + Math.floor(rnd() * 4) });
    } else {
      calVersion += 1;
      const holidays = DATES.filter(() => rnd() < 0.4);
      events.push({ type: 'calendar', version: calVersion, holidays });
    }
  }
  return events;
}

function replayAll(events) {
  const s = createState();
  const applied = [];
  for (const ev of events) {
    try {
      applyEvent(s, ev);
      applied.push(ev);
    } catch {
      // invalid random events (e.g. cancel of cancelled trade) are skipped by
      // both sides identically, keeping the comparison honest
    }
  }
  return s;
}

test('incremental engine matches full recompute on random event streams', () => {
  for (const seed of [1, 7, 42, 1337, 20261003]) {
    const events = genEvents(seed, 40);
    const inc = createState();
    const applied = [];
    for (const ev of events) {
      let ok = true;
      try {
        applyEvent(inc, ev);
      } catch {
        ok = false;
      }
      if (!ok) continue;
      applied.push(ev);
      // differential/incremental reports vs fresh full recompute of the prefix
      const fresh = replayAll(applied);
      assert.deepEqual(reports(inc), reports(fresh), `seed=${seed} diverged after ${JSON.stringify(ev)}`);
      // also compare incremental cache against cache-free bucket computation
      assert.deepEqual(reports(inc), reports(inc, true), `seed=${seed} cache mismatch`);
    }
  }
});
