import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditStore } from '../src/auditdb.js';
import { bruteAsOf } from '../src/brute.js';

// Deterministic PRNG (mulberry32) so the 2000-version corpus is reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 24 * 3600 * 1000;
const T0 = Date.parse('2023-01-01T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

function buildCorpus(n) {
  const rand = mulberry32(20261002);
  const accounts = Array.from({ length: 20 }, (_, i) => `acc-${i}`);
  const events = [];
  const tipByAccount = new Map(); // account -> latest live event id
  let txSeq = 0;
  for (let i = 0; i < n; i += 1) {
    const account = accounts[Math.floor(rand() * accounts.length)];
    txSeq += 1;
    const roll = rand();
    const tip = tipByAccount.get(account);
    if (tip !== undefined && roll < 0.08) {
      // Tombstone (delete request).
      events.push({ id: `e${i}`, account, txSeq, tombstone: true, supersedes: tip });
      tipByAccount.delete(account);
      continue;
    }
    const e = {
      id: `e${i}`,
      account,
      txSeq,
      // Backfill: validFrom may reach up to 400 days into the past.
      validFrom: iso(T0 + Math.floor(rand() * 1000) * DAY - (roll < 0.4 ? Math.floor(rand() * 400) * DAY : 0)),
      validTo: rand() < 0.5 ? null : undefined, // filled below when not NULL
      payload: {},
    };
    if (e.validTo === undefined) {
      e.validTo = iso(Date.parse(e.validFrom) + (1 + Math.floor(rand() * 365)) * DAY);
    }
    if (rand() < 0.8) e.payload.amount = Math.floor(rand() * 1000) - 500;
    else e.payload.amount = null; // NULL amount: skipped by sum, counted by count
    if (rand() < 0.5) e.payload.limit = Math.floor(rand() * 100);
    if (tip !== undefined && roll < 0.35) e.supersedes = tip; // correction chain
    if (e.supersedes === undefined || roll < 0.9) tipByAccount.set(account, e.id);
    events.push(e);
  }
  return { events, accounts, maxTxSeq: txSeq };
}

test('C: indexed asOf matches brute force over 2000 versions', () => {
  const { events, accounts, maxTxSeq } = buildCorpus(2000);
  const store = new AuditStore();
  for (const raw of events) store.append(raw);
  assert.equal(store.events.length, 2000);

  const rand = mulberry32(777);
  for (let q = 0; q < 500; q += 1) {
    const account = accounts[Math.floor(rand() * accounts.length)];
    const validTime = iso(T0 + Math.floor(rand() * 1400) * DAY - 200 * DAY);
    const txSeq = 1 + Math.floor(rand() * maxTxSeq);
    assert.deepEqual(
      store.asOf(account, validTime, txSeq),
      bruteAsOf(store.events, account, validTime, txSeq),
      `mismatch for ${account} @ ${validTime} tx=${txSeq}`,
    );
  }
});

test('C: indexed query never scans the full table', () => {
  const { events, accounts, maxTxSeq } = buildCorpus(2000);
  const store = new AuditStore();
  for (const raw of events) store.append(raw);

  store.stats.scanned = 0;
  store.asOf(accounts[0], '2024-06-01T00:00:00Z', maxTxSeq);
  const chainLen = store.byAccount.get(accounts[0]).length;
  // One indexed query touches exactly one version chain, never the full log.
  assert.equal(store.stats.scanned, chainLen);
  assert.ok(store.stats.scanned < events.length / 10, `scanned ${store.stats.scanned} (total ${events.length})`);
  const unknown = store.asOf('no-such-account', '2024-06-01T00:00:00Z', maxTxSeq);
  assert.deepEqual(unknown, { balance: 0, limitUsed: 0, versions: 0 });
});
