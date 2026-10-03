import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditDB } from '../src/db.js';

// Deterministic PRNG (LCG) so the 2000-version fixture is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.parse('2024-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function generate(count, seed = 42) {
  const rnd = lcg(seed);
  const accounts = Array.from({ length: 25 }, (_, i) => `acc-${i}`);
  const correctable = new Map(accounts.map((a) => [a, []])); // account -> non-tombstone ids
  const events = [];
  for (let i = 1; i <= count; i++) {
    const account = accounts[Math.floor(rnd() * accounts.length)];
    const pool = correctable.get(account);
    const roll = rnd();
    const validFromMs = BASE + Math.floor(rnd() * 300) * DAY;
    const validTo = rnd() < 0.5 ? null : iso(validFromMs + (1 + Math.floor(rnd() * 90)) * DAY);
    const validFrom = iso(validFromMs);
    if (pool.length > 0 && roll < 0.35) {
      // correction of an existing version
      const target = pool[Math.floor(rnd() * pool.length)];
      events.push({
        id: `e${i}`, account, validFrom, validTo, txSeq: i,
        payload: { amount: rnd() < 0.2 ? null : Math.floor(rnd() * 1000) - 500,
                   limit: rnd() < 0.3 ? null : Math.floor(rnd() * 100) },
        supersedes: target,
      });
      pool.push(`e${i}`);
    } else if (pool.length > 0 && roll < 0.45) {
      // tombstone a chain: remove its versions from the correctable pool
      const target = pool[Math.floor(rnd() * pool.length)];
      events.push({ id: `e${i}`, account, validFrom, validTo, txSeq: i,
                    supersedes: target, tombstone: true });
      const rootOf = (id) => events.find((e) => e.id === id)?.rootId ?? id;
      const root = rootOf(target);
      const remaining = pool.filter((id) => (rootOf(id) !== root));
      correctable.set(account, remaining);
    } else {
      // brand-new chain
      events.push({
        id: `e${i}`, account, validFrom, validTo, txSeq: i,
        payload: { amount: rnd() < 0.2 ? null : Math.floor(rnd() * 1000) - 500,
                   limit: rnd() < 0.3 ? null : Math.floor(rnd() * 100) },
      });
      pool.push(`e${i}`);
    }
    events[events.length - 1].rootId = events[events.length - 1].supersedes
      ? (events.find((e) => e.id === events[events.length - 1].supersedes)?.rootId
         ?? events[events.length - 1].supersedes)
      : `e${i}`;
  }
  for (const e of events) delete e.rootId;
  return events;
}

test('C: indexed asOf matches brute force across 2000 versions', () => {
  const events = generate(2000);
  const db = new AuditDB();
  db.load(events);
  assert.equal(db.events.length, 2000);

  const rnd = lcg(7);
  const accounts = Array.from({ length: 25 }, (_, i) => `acc-${i}`);
  let checks = 0;
  for (let k = 0; k < 400; k++) {
    const account = accounts[Math.floor(rnd() * accounts.length)];
    const valid = iso(BASE + Math.floor(rnd() * 420) * DAY);
    const txSeq = 1 + Math.floor(rnd() * 2000);
    const indexed = db.asOf(account, valid, txSeq);
    const brute = db.asOfBruteForce(account, valid, txSeq);
    assert.deepEqual(indexed, brute,
      `mismatch at account=${account} valid=${valid} tx=${txSeq}`);
    checks++;
  }
  // Also compare the "latest" view (tx = infinity) for every account.
  for (const account of accounts) {
    for (let d = 0; d <= 400; d += 40) {
      const valid = iso(BASE + d * DAY);
      assert.deepEqual(db.asOf(account, valid), db.asOfBruteForce(account, valid));
      checks++;
    }
  }
  assert.ok(checks > 600, `expected >600 comparisons, ran ${checks}`);
});
