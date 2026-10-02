'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Ledger } = require('../src/ledger');

// Deterministic PRNG so the 5000-event corpus is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ['m1', 'm2', 'm3', 'm4'];
const DAYS = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CNY', 'XTS', 'DOGE', null];

function generateEvents(n, seed = 42) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const events = [];
  const open = [];
  for (let i = 0; i < n; i++) {
    if (open.length === 0 || rnd() < 0.55) {
      const id = `t${i}`;
      const amount = rnd() < 0.1 ? null : Math.round(rnd() * 100000) / 100;
      const tip = rnd() < 0.3 ? null : Math.round(rnd() * 2000) / 100;
      events.push({
        type: 'auth', id, merchant: pick(MERCHANTS), day: pick(DAYS),
        amount, currency: pick(CURRENCIES), tip,
      });
      open.push(id);
    } else {
      const id = open.splice(Math.floor(rnd() * open.length), 1)[0];
      const roll = rnd();
      // Capture events omit "day" and inherit the auth day, so every event
      // of a transaction shares one day and day-based rollback stays causal.
      if (roll < 0.7) {
        events.push({ type: 'capture', id });
      } else if (roll < 0.8) {
        events.push({ type: 'void', id });
      } else if (roll < 0.9) {
        events.push({ type: 'capture', id });
        events.push({ type: 'refund', id });
        if (rnd() < 0.5) events.push({ type: 'reverse', id });
      } else {
        events.push({ type: 'capture', id });
        events.push({ type: 'chargeback', id });
        if (rnd() < 0.5) events.push({ type: 'reverse_chargeback', id });
      }
    }
  }
  return events;
}

function applyAll(events) {
  const l = new Ledger();
  for (const e of events) l.apply(e);
  return l;
}

test('C: incremental materialized stats match brute-force scan over 5000 events', () => {
  const events = generateEvents(5000);
  const ledger = applyAll(events);
  const captures = events.filter((e) => e.type === 'capture').length;
  assert.ok(captures > 500, `corpus should contain many captures, got ${captures}`);
  for (const merchant of MERCHANTS) {
    for (const day of DAYS) {
      assert.deepEqual(
        ledger.merchantStats(merchant, day),
        ledger.bruteForceStats(merchant, day),
        `stats mismatch for ${merchant}/${day}`,
      );
    }
  }
});

test('C: recomputeDay repairs a corrupted materialized bucket', () => {
  const events = generateEvents(5000, 7);
  const ledger = applyAll(events);
  // Pick a materialized bucket that actually exists and corrupt it on purpose.
  let target;
  for (const [key, agg] of ledger.stats) {
    if (agg.buckets.size > 0) { target = { key, agg }; break; }
  }
  assert.ok(target, 'corpus should materialize at least one bucket');
  const [merchant, day] = target.key.split(' ');
  const currency = target.agg.buckets.keys().next().value;
  target.agg.buckets.get(currency).sum = -999;
  const repaired = ledger.recomputeDay(merchant, day);
  assert.deepEqual(repaired, ledger.bruteForceStats(merchant, day));
  assert.deepEqual(ledger.merchantStats(merchant, day), ledger.bruteForceStats(merchant, day));
});

test('C: rollbackTo(day) replays prefix and matches a fresh ledger', () => {
  const events = generateEvents(5000, 99);
  const ledger = applyAll(events);
  const cutDay = '2026-09-30';
  ledger.rollbackTo(cutDay);
  // Fresh ledger fed only events up to and including the cut day.
  const reference = new Ledger();
  for (const e of events) {
    const day = typeof e.day === 'string' ? e.day : reference.txns.get(e.id)?.authDay;
    if (day !== undefined && day <= cutDay) reference.apply(e);
  }
  for (const merchant of MERCHANTS) {
    for (const day of DAYS) {
      assert.deepEqual(
        ledger.merchantStats(merchant, day),
        reference.merchantStats(merchant, day),
        `post-rollback stats mismatch for ${merchant}/${day}`,
      );
    }
  }
  assert.deepEqual(ledger.log, reference.log);
  assert.equal(ledger.txns.size, reference.txns.size);
});

test('C: rollback drops causal dependents of events beyond the cut day', () => {
  const l = new Ledger();
  l.apply({ type: 'auth', id: 'k1', merchant: 'm', day: '2026-10-01', amount: 10, currency: 'USD', tip: null });
  l.apply({ type: 'capture', id: 'k1', day: '2026-10-05' }); // explicit later day
  l.apply({ type: 'refund', id: 'k1' });                     // no day: inherits auth day
  l.apply({ type: 'auth', id: 'k2', merchant: 'm', day: '2026-10-02', amount: 20, currency: 'USD', tip: null });
  l.apply({ type: 'capture', id: 'k2' });
  l.rollbackTo('2026-10-03');
  // k1's capture is beyond the cut, so the capture AND its refund are gone;
  // the auth itself (2026-10-01) survives.
  assert.equal(l.txns.get('k1').state, 'auth');
  assert.equal(l.txns.get('k2').state, 'captured');
  assert.deepEqual(l.merchantStats('m', '2026-10-05').buckets, {});
  assert.equal(l.merchantStats('m', '2026-10-02').buckets.USD.sum, 20);
});
