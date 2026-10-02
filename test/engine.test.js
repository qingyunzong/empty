import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, replay, sortEvents } from '../src/engine.js';

test('boundary: hold equal to full limit succeeds, next unit is INSUFFICIENT with no partial state', () => {
  const engine = new Engine();
  engine.applyAll([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 1000 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 1000 },
  ]);
  let snap = engine.snapshot();
  assert.equal(snap.accounts.a1.held, 1000);
  assert.equal(snap.accounts.a1.available, 0);

  const record = engine.apply({ seq: 3, requestId: 'auth2', type: 'authorize', authId: 'au2', account: 'a1', amount: 1 });
  assert.equal(record.ok, false);
  assert.equal(record.reason, 'INSUFFICIENT');
  assert.deepEqual(record.deltas, []);

  snap = engine.snapshot();
  assert.equal(snap.accounts.a1.held, 1000);
  assert.equal(snap.accounts.a1.available, 0);
  assert.equal(snap.auths.au2, undefined);
});

test('release may not exceed remaining hold; rejected release leaves state untouched', () => {
  const engine = new Engine();
  engine.applyAll([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 500 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 200 },
    { seq: 3, requestId: 'rel1', type: 'release', authId: 'au1', amount: 50 },
  ]);
  const record = engine.apply({ seq: 4, requestId: 'rel2', type: 'release', authId: 'au1', amount: 151 });
  assert.equal(record.ok, false);
  assert.equal(record.reason, 'EXCEEDS_HOLD');
  const snap = engine.snapshot();
  assert.equal(snap.auths.au1.heldRemaining, 150);
  assert.equal(snap.accounts.a1.held, 150);
  assert.equal(snap.accounts.a1.available, 350);
});

test('void of a partially settled authorization keeps captures and frees the rest', () => {
  const engine = new Engine();
  engine.applyAll([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 1000 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 500 },
    { seq: 3, requestId: 'cap1', type: 'capture', authId: 'au1', amount: 200, merchant: 'm1' },
  ]);
  const record = engine.apply({ seq: 4, requestId: 'void1', type: 'void', authId: 'au1' });
  assert.equal(record.ok, true);
  const snap = engine.snapshot();
  assert.equal(snap.auths.au1.status, 'voided');
  assert.equal(snap.auths.au1.heldRemaining, 0);
  assert.equal(snap.auths.au1.captured, 200);
  assert.equal(snap.accounts.a1.held, 0);
  assert.equal(snap.accounts.a1.captured, 200);
  assert.equal(snap.accounts.a1.available, 800);
  assert.equal(snap.merchants.m1.settled, 200);

  const again = engine.apply({ seq: 5, requestId: 'void2', type: 'void', authId: 'au1' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'NO_ACTIVE_AUTH');
});

test('authId reuse after void starts a new generation and invalidates the old node', () => {
  const engine = new Engine();
  engine.applyAll([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 300 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 100 },
    { seq: 3, requestId: 'void1', type: 'void', authId: 'au1' },
  ]);
  const record = engine.apply({ seq: 4, requestId: 'auth2', type: 'authorize', authId: 'au1', account: 'a1', amount: 250 });
  assert.equal(record.ok, true);
  assert.equal(record.deltas[0].node, 'auth:au1#1');
  assert.equal(record.deltas[0].after, 'invalidated');
  const snap = engine.snapshot();
  assert.equal(snap.auths.au1.generation, 2);
  assert.equal(snap.auths.au1.heldRemaining, 250);
  assert.equal(snap.accounts.a1.available, 50);
});

test('concurrent captures: total order by (seq, requestId), stable across all input permutations', () => {
  const base = [
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 1000 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 100 },
  ];
  const concurrent = [
    { seq: 7, requestId: 'cap-b', type: 'capture', authId: 'au1', amount: 60, merchant: 'm1' },
    { seq: 7, requestId: 'cap-a', type: 'capture', authId: 'au1', amount: 60, merchant: 'm1' },
    { seq: 7, requestId: 'cap-c', type: 'capture', authId: 'au1', amount: 40, merchant: 'm2' },
  ];
  const events = [...base, ...concurrent];

  function permutations(items) {
    if (items.length <= 1) return [items];
    const out = [];
    for (let i = 0; i < items.length; i += 1) {
      const rest = [...items.slice(0, i), ...items.slice(i + 1)];
      for (const perm of permutations(rest)) {
        out.push([items[i], ...perm]);
      }
    }
    return out;
  }

  const expected = replay(events);
  const expectedSnap = JSON.stringify(expected.snapshot());
  const expectedOutcomes = JSON.stringify(expected.journal.map((r) => [r.requestId, r.ok, r.reason ?? null]));

  const perms = permutations(events);
  assert.equal(perms.length, 120);
  for (const perm of perms) {
    const engine = replay(perm);
    assert.equal(JSON.stringify(engine.snapshot()), expectedSnap);
    assert.equal(
      JSON.stringify(engine.journal.map((r) => [r.requestId, r.ok, r.reason ?? null])),
      expectedOutcomes,
    );
  }

  const snap = expected.snapshot();
  assert.equal(snap.accounts.a1.captured, 100);
  assert.equal(snap.accounts.a1.held, 0);
  const byId = new Map(expected.journal.map((r) => [r.requestId, r]));
  assert.equal(byId.get('cap-a').ok, true);
  assert.equal(byId.get('cap-c').ok, true);
  assert.equal(byId.get('cap-b').ok, false);
  assert.equal(byId.get('cap-b').reason, 'EXCEEDS_HOLD');
});

test('deterministic recompute: replay of any prefix matches incremental application', () => {
  function mulberry32(seed) {
    let t = seed;
    return () => {
      t += 0x6d2b79f5;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(42);
  const events = [{ seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 1000 }];
  let authCounter = 0;
  const activeAuths = [];
  for (let seq = 2; seq <= 60; seq += 1) {
    const roll = rand();
    const requestId = `r${seq}`;
    if (roll < 0.4 || activeAuths.length === 0) {
      authCounter += 1;
      const authId = `au${authCounter}`;
      activeAuths.push(authId);
      events.push({ seq, requestId, type: 'authorize', authId, account: 'a1', amount: 1 + Math.floor(rand() * 300) });
    } else {
      const authId = activeAuths[Math.floor(rand() * activeAuths.length)];
      const kind = rand();
      if (kind < 0.4) {
        events.push({ seq, requestId, type: 'capture', authId, amount: 1 + Math.floor(rand() * 120), merchant: `m${1 + Math.floor(rand() * 3)}` });
      } else if (kind < 0.8) {
        events.push({ seq, requestId, type: 'release', authId, amount: 1 + Math.floor(rand() * 120) });
      } else {
        events.push({ seq, requestId, type: 'void', authId });
      }
    }
  }

  const ordered = sortEvents(events);
  const incremental = new Engine();
  for (let n = 0; n <= ordered.length; n += 1) {
    const recomputed = replay(events, n);
    assert.equal(JSON.stringify(recomputed.snapshot()), JSON.stringify(incremental.snapshot()), `prefix ${n}`);
    if (n < ordered.length) incremental.apply(ordered[n]);
  }
});

test('journal explains every change with before/after deltas', () => {
  const engine = new Engine();
  engine.applyAll([
    { seq: 1, requestId: 'open', type: 'open_account', account: 'a1', limit: 100 },
    { seq: 2, requestId: 'auth1', type: 'authorize', authId: 'au1', account: 'a1', amount: 40 },
    { seq: 3, requestId: 'cap1', type: 'capture', authId: 'au1', amount: 10, merchant: 'm1' },
  ]);
  const [openRec, authRec, capRec] = engine.journal;
  assert.deepEqual(openRec.deltas[0], { node: 'account:a1', field: 'limit', before: null, after: 100 });
  assert.deepEqual(authRec.deltas[0], { node: 'account:a1', field: 'held', before: 0, after: 40 });
  const merchantDelta = capRec.deltas.find((d) => d.node === 'merchant:m1');
  assert.deepEqual(merchantDelta, { node: 'merchant:m1', field: 'settled', before: 0, after: 10 });
});
