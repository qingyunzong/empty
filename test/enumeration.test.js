import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/engine.js';
import { verifyCertificate } from '../src/core.js';

// Discrete-event enumeration cross-check: for every assignment of slots to a
// fixed set of n <= 9 events, the heap-indexed engine and the naive scanning
// engine must produce identical output, every certificate must verify, and
// the no-overauth invariant must hold at every slot.

const CONFIG = {
  pool: 100,
  agingK: 2,
  preemptWindow: 2,
  cards: { c1: 120, c2: 90 },
};

// Event templates: slots are assigned by the enumeration.
const TEMPLATES = [
  (s) => ({ slot: s, type: 'auth', id: 'a1', card: 'c1', amount: 40, priority: 0, expiry: s + 2 }),
  (s) => ({ slot: s, type: 'auth', id: 'a2', card: 'c1', amount: 40, priority: 1, expiry: s + 3 }),
  (s) => ({ slot: s, type: 'auth', id: 'a3', card: 'c2', amount: 50, priority: 2, expiry: s + 1 }),
  (s) => ({ slot: s, type: 'auth', id: 'a4', card: 'c2', amount: 25, priority: 3, expiry: s + 2 }),
  (s) => ({ slot: s, type: 'capture', id: 'a1' }),
  (s) => ({ slot: s, type: 'capture', id: 'a2' }),
  (s) => ({ slot: s, type: 'capture', id: 'a3' }),
  (s) => ({ slot: s, type: 'revoke', id: 'a4' }),
  (s) => ({ slot: s, type: 'revoke', id: 'a1' }),
];

function checkRun(events) {
  const heap = new Engine(CONFIG, { strategy: 'heap' }).run(events);
  const naive = new Engine(CONFIG, { strategy: 'naive' }).run(events);
  assert.deepEqual(naive, heap, `engine mismatch for ${JSON.stringify(events)}`);
  for (const cert of heap.certificates) {
    assert.ok(verifyCertificate(cert), `certificate failed at slot ${cert.slot}`);
    assert.ok(cert.pool.used <= CONFIG.pool);
    for (const [card, c] of Object.entries(cert.cards)) assert.ok(c.used <= c.limit);
  }
  // determinism: same input, same bytes
  const again = new Engine(CONFIG, { strategy: 'heap' }).run(events);
  assert.equal(JSON.stringify(again), JSON.stringify(heap));
}

test('enumeration: all slot assignments for n=6 events over 3 slots', () => {
  const n = 6;
  const slots = [0, 1, 2];
  const total = slots.length ** n; // 729
  for (let mask = 0; mask < total; mask++) {
    let m = mask;
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push(TEMPLATES[i](slots[m % slots.length]));
      m = Math.floor(m / slots.length);
    }
    checkRun(events);
  }
});

test('enumeration: all slot assignments for n=9 events over 2 slots', () => {
  const n = 9;
  const slots = [0, 1];
  const total = slots.length ** n; // 512
  for (let mask = 0; mask < total; mask++) {
    let m = mask;
    const events = [];
    for (let i = 0; i < n; i++) {
      events.push(TEMPLATES[i](slots[m % slots.length]));
      m = Math.floor(m / slots.length);
    }
    checkRun(events);
  }
});

// Seeded PRNG (mulberry32) for reproducible fuzzing.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('fuzz: 300 random 9-event scenarios, heap vs naive + invariants', () => {
  const rand = mulberry32(20261003);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let iter = 0; iter < 300; iter++) {
    const events = [];
    for (let i = 0; i < 9; i++) {
      const slot = Math.floor(rand() * 5);
      const kind = pick(['auth', 'auth', 'auth', 'capture', 'revoke']);
      if (kind === 'auth') {
        events.push({
          slot,
          type: 'auth',
          id: `f${iter}-${i}`,
          card: pick(['c1', 'c2']),
          amount: 10 + Math.floor(rand() * 80),
          priority: Math.floor(rand() * 4),
          expiry: slot + Math.floor(rand() * 4),
        });
      } else {
        events.push({ slot, type: kind, id: `f${iter}-${Math.floor(rand() * 9)}` });
      }
    }
    checkRun(events);
  }
});

test('starvation bound holds across enumeration: max-aged FIFO within priority', () => {
  // A queued request at max aging is never overtaken by a later-submitted
  // request of equal base priority. Enumerate release slots to prove it.
  for (let releaseSlot = 3; releaseSlot <= 9; releaseSlot++) {
    const events = [
      { slot: 0, type: 'auth', id: 'anchor', card: 'c1', amount: 100, priority: 5, expiry: releaseSlot },
      { slot: 0, type: 'auth', id: 'waiter', card: 'c1', amount: 60, priority: 1, expiry: 40 },
      { slot: 1, type: 'auth', id: 'late1', card: 'c1', amount: 60, priority: 1, expiry: 40 },
      { slot: 2, type: 'auth', id: 'late2', card: 'c1', amount: 60, priority: 1, expiry: 40 },
    ];
    const r = new Engine({ pool: 100, agingK: 2, preemptWindow: 0, cards: { c1: 500 } }).run(events);
    const firstWake = r.wakes[0];
    assert.ok(firstWake, `no wake at all for releaseSlot=${releaseSlot}`);
    assert.equal(firstWake.woke, 'waiter', `waiter overtaken for releaseSlot=${releaseSlot}`);
    // Bound: admitted no later than the first release at/after submit + 2*agingK.
    assert.ok(firstWake.slot <= Math.max(releaseSlot, 0 + 2 * 2));
  }
});
