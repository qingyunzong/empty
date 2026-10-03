// Discrete-event enumeration cross-check: for small event streams (n <= 9)
// the heap-based engine must produce byte-identical output to an independent
// reference implementation, and every certificate must verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, verifyCertificate } from '../src/engine.js';
import { runReference } from './reference.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScenario(rand) {
  const n = 1 + Math.floor(rand() * 9); // 1..9 events
  const config = {
    pool: [50, 80, 100, 150][Math.floor(rand() * 4)],
    cards: { c1: [40, 90, 200][Math.floor(rand() * 3)] },
    agingK: 1 + Math.floor(rand() * 3),
    preemptWindow: 1 + Math.floor(rand() * 3),
  };
  if (rand() < 0.5) config.cards.c2 = [50, 120][Math.floor(rand() * 2)];
  const cards = Object.keys(config.cards);
  const events = [];
  for (let i = 0; i < n; i++) {
    const slot = Math.floor(rand() * 7);
    const roll = rand();
    if (roll < 0.6) {
      events.push({
        type: 'auth',
        id: `a${Math.floor(rand() * 5)}`,
        card: cards[Math.floor(rand() * cards.length)],
        amount: (1 + Math.floor(rand() * 8)) * 10,
        priority: Math.floor(rand() * 4),
        slot,
        expires: slot + 1 + Math.floor(rand() * 6),
      });
    } else {
      events.push({
        type: roll < 0.8 ? 'capture' : 'revoke',
        id: `a${Math.floor(rand() * 5)}`,
        slot,
        ...(rand() < 0.4 ? { amount: (1 + Math.floor(rand() * 5)) * 10 } : {}),
      });
    }
  }
  return { config, events };
}

function normalize(result) {
  // Compare the semantically relevant output; certificate `ok` flags are
  // re-derived below via verifyCertificate.
  return JSON.stringify({
    timeline: result.timeline,
    violations: result.violations,
    queue: result.queue,
    certificates: result.certificates.map(({ ok, ...rest }) => rest),
  });
}

test('enumeration: engine matches reference on 400 random scenarios (n<=9)', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { config, events } = randomScenario(mulberry32(seed));
    assert.ok(events.length <= 9);
    const actual = createEngine(config).run(events);
    const expected = runReference(config, events);
    assert.equal(
      normalize(actual), normalize(expected),
      `divergence at seed ${seed}: ${JSON.stringify({ config, events })}`);
    for (const cert of actual.certificates) {
      const check = verifyCertificate(cert);
      assert.ok(check.ok, `bad certificate at seed ${seed}: ${check.errors}`);
    }
  }
});

test('enumeration: all 120 permutations of a fixed 5-event stream agree', () => {
  const config = { pool: 100, cards: { c1: 150 }, agingK: 2, preemptWindow: 2 };
  const base = [
    { type: 'auth', id: 'x', card: 'c1', amount: 60, priority: 0, slot: 0, expires: 3 },
    { type: 'auth', id: 'y', card: 'c1', amount: 50, priority: 1, slot: 1, expires: 6 },
    { type: 'auth', id: 'z', card: 'c1', amount: 70, priority: 2, slot: 1, expires: 8 },
    { type: 'capture', id: 'x', slot: 2 },
    { type: 'revoke', id: 'y', slot: 2 },
  ];
  const permute = (arr) => {
    if (arr.length <= 1) return [arr];
    return arr.flatMap((x, i) =>
      permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
  };
  for (const events of permute(base)) {
    const actual = createEngine(config).run(events);
    const expected = runReference(config, events);
    assert.equal(normalize(actual), normalize(expected));
  }
});

test('enumeration: engine is deterministic (same input, same output twice)', () => {
  const { config, events } = randomScenario(mulberry32(42));
  const a = createEngine(config).run(events);
  const b = createEngine(config).run(events);
  assert.deepEqual(a, b);
});
