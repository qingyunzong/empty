import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../src/compile.js';
import { Engine } from '../src/engine.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POLICY_SRC = `
customer C0001;
note /^[A-Z0-9-]{3,32}$/;
bucket b { limit 100000; }
approval L1 { cap b 8000;
  approval L2 { cap b 5000; } }
`;

function genEvents(rand, n) {
  const events = [];
  const day = 24 * 3600 * 1000;
  const base = Date.parse('2026-01-05T00:00:00Z');
  const untils = ['2026-02-01', '2026-03-01', '2026-04-01'];
  let clock = base;
  let seq = 0;
  const freezeIds = [];
  for (let i = 0; i < n; i++) {
    clock += Math.floor(rand() * 6 * 3600 * 1000); // advance 0..6h
    if (rand() < 0.15) clock += day * Math.floor(rand() * 20); // occasional big jump
    const ts = new Date(clock).toISOString();
    const r = rand();
    const id = `E${String(seq++).padStart(4, '0')}`;
    if (r < 0.35) {
      const fid = `F${seq}`;
      freezeIds.push(fid);
      events.push({
        type: 'freeze', id: fid, ts, customer: rand() < 0.05 ? 'C9999' : 'C0001',
        bucket: 'b', amount: 1 + Math.floor(rand() * 3000),
        until: untils[Math.floor(rand() * untils.length)],
        note: rand() < 0.1 ? 'bad note' : `REQ-${seq}`,
        scope: rand() < 0.5 ? ['L1'] : ['L1', 'L2'],
      });
    } else if (r < 0.55) {
      events.push({
        type: 'unfreeze', id, ts, customer: 'C0001', bucket: 'b',
        amount: 1 + Math.floor(rand() * 1500),
        note: `REQ-${seq}`,
        freeze_id: freezeIds.length ? freezeIds[Math.floor(rand() * freezeIds.length)] : 'F-none',
      });
    } else if (r < 0.8) {
      const useFreeze = rand() < 0.5 && freezeIds.length;
      events.push({
        type: 'debit', id, ts, customer: 'C0001', bucket: 'b',
        amount: 1 + Math.floor(rand() * 1200),
        note: `REQ-${seq}`,
        ...(useFreeze ? { freeze_id: freezeIds[Math.floor(rand() * freezeIds.length)] } : {}),
      });
    } else {
      const d = new Date(base + day * Math.floor(rand() * 120));
      events.push({ type: 'business_day', id, date: d.toISOString().slice(0, 10) });
    }
  }
  return events;
}

// Independent reference: a from-scratch enumeration of the same semantics,
// sharing no code with the Engine under test.
function reference(events) {
  const LIMIT = 100000;
  const CAPS = { L1: 8000, 'L1/L2': 5000 };
  const NOTE = /^[A-Z0-9-]{3,32}$/;
  const st = { available: LIMIT, frozen: 0, used: 0 };
  const freezes = new Map();
  const scopeFrozen = { L1: 0, 'L1/L2': 0 };
  const ts = (ev) => Date.parse(ev.ts ?? ev.date + 'T00:00:00Z');
  const sorted = [...events].sort((a, b) => (ts(a) - ts(b)) || (String(a.id) < String(b.id) ? -1 : 1));
  for (const ev of sorted) {
    if (ev.type === 'business_day') {
      const dayStart = Date.parse(ev.date + 'T00:00:00Z');
      for (const f of freezes.values()) {
        if (!f.expired && Date.parse(f.until + 'T00:00:00Z') <= dayStart) {
          const rem = f.amount - f.used;
          st.frozen -= rem; st.available += rem;
          scopeFrozen[f.scope] -= rem;
          f.expired = true;
        }
      }
      continue;
    }
    if (ev.customer !== 'C0001' || !NOTE.test(String(ev.note ?? ''))) continue;
    if (!Number.isSafeInteger(ev.amount) || ev.amount <= 0) continue;
    if (ev.type === 'freeze') {
      if (freezes.has(ev.id)) continue;
      if (!(ts(ev) < Date.parse(ev.until + 'T00:00:00Z'))) continue;
      const key = ev.scope.join('/');
      if (!(key in CAPS)) continue;
      if (ev.amount > st.available) continue;
      if (scopeFrozen['L1'] + ev.amount > CAPS['L1']) continue;
      if (key === 'L1/L2' && scopeFrozen['L1/L2'] + ev.amount > CAPS['L1/L2']) continue;
      st.available -= ev.amount; st.frozen += ev.amount;
      scopeFrozen['L1'] += ev.amount;
      if (key === 'L1/L2') scopeFrozen['L1/L2'] += ev.amount;
      freezes.set(ev.id, { amount: ev.amount, used: 0, until: ev.until, scope: key, expired: false });
    } else if (ev.type === 'unfreeze' || (ev.type === 'debit' && ev.freeze_id)) {
      const f = freezes.get(ev.freeze_id);
      if (!f || f.expired || !(ts(ev) < Date.parse(f.until + 'T00:00:00Z'))) continue;
      const rem = f.amount - f.used;
      if (ev.amount > rem) continue;
      if (ev.type === 'unfreeze') {
        f.amount -= ev.amount; st.frozen -= ev.amount; st.available += ev.amount;
      } else {
        f.used += ev.amount; st.frozen -= ev.amount; st.used += ev.amount;
      }
      scopeFrozen['L1'] -= ev.amount;
      if (f.scope === 'L1/L2') scopeFrozen['L1/L2'] -= ev.amount;
    } else if (ev.type === 'debit') {
      if (ev.amount > st.available) continue;
      st.available -= ev.amount; st.used += ev.amount;
    }
  }
  return st;
}

for (const seed of [1, 7, 42, 1337, 20261007]) {
  test(`acceptance 4: random event stream matches independent reference (seed=${seed})`, () => {
    const rand = mulberry32(seed);
    const events = genEvents(rand, 400);
    const eng = new Engine(compileSource(POLICY_SRC));
    eng.applyAll(events);
    const got = eng.buckets.get('b');
    const want = reference(events);
    assert.deepEqual(
      { available: got.available, frozen: got.frozen, used: got.used },
      want,
    );
    assert.equal(got.available + got.frozen + got.used, 100000, 'quota conservation invariant');
  });
}
