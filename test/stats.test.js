import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { bruteForceStats } from '../src/stats.js';

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = Array.from({ length: 10 }, (_, i) => `m${i}`);
const CURRENCIES = ['USD', 'USD', 'EUR', 'CNY', 'JPY', 'GBP', 'XAU', 'XAU', null];
const DAYS = Array.from({ length: 30 }, (_, i) => `2024-03-${String(i + 1).padStart(2, '0')}`);

function generateEvents(count) {
  const rand = mulberry32(42);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const maybeAmount = (max) => (rand() < 0.1 ? null : Math.floor(rand() * max));
  const events = [];
  let idSeq = 0;
  while (events.length < count) {
    const id = `t${idSeq++}`;
    const merchant = pick(MERCHANTS);
    const day = pick(DAYS);
    events.push({
      type: 'auth',
      id,
      merchant,
      day,
      amount: maybeAmount(10000),
      currency: pick(CURRENCIES),
      tip: rand() < 0.4 ? null : Math.floor(rand() * 500),
    });
    const roll = rand();
    if (roll < 0.65) {
      events.push({ type: 'capture', id, day: pick(DAYS) });
      const after = rand();
      if (after < 0.2) {
        events.push({ type: 'refund', id });
        if (rand() < 0.5) events.push({ type: 'reverse_refund', id });
      } else if (after < 0.4) {
        events.push({ type: 'chargeback', id });
        if (rand() < 0.5) events.push({ type: 'reverse_chargeback', id });
      }
    } else if (roll < 0.8) {
      events.push({ type: 'void', id });
    }
  }
  return events.slice(0, count);
}

test('C: incremental stats match brute-force scan over 5000 events', () => {
  const events = generateEvents(5000);
  assert.equal(events.length, 5000);
  // sanity: dataset really exercises NULLs and unknown currencies
  assert.ok(events.some((e) => e.type === 'auth' && e.tip === null));
  assert.ok(events.some((e) => e.type === 'auth' && e.currency === null));
  assert.ok(events.some((e) => e.type === 'auth' && e.currency === 'XAU'));

  const ledger = new Ledger();
  for (const event of events) ledger.apply(event);

  for (const merchant of MERCHANTS) {
    for (const day of DAYS) {
      assert.deepEqual(
        ledger.merchantStats(merchant, day),
        bruteForceStats(ledger.captures, merchant, day),
        `stats mismatch for ${merchant} on ${day}`,
      );
    }
  }
});

test('C: backtracking recompute from a mid-range day matches brute force', () => {
  const events = generateEvents(5000);
  const ledger = new Ledger();
  for (const event of events) ledger.apply(event);

  const fromDay = '2024-03-15';
  for (const merchant of MERCHANTS) ledger.recomputeStats(merchant, fromDay);

  for (const merchant of MERCHANTS) {
    for (const day of DAYS) {
      assert.deepEqual(
        ledger.merchantStats(merchant, day),
        bruteForceStats(ledger.captures, merchant, day),
        `post-recompute mismatch for ${merchant} on ${day}`,
      );
    }
  }
});
