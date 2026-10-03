'use strict';

// Acceptance 4: for op sets of up to 6 operations, enumerate every
// concurrent interleaving (permutation) and check the engine against an
// independent serial reference model: identical ledger, balances and
// rejections for every interleaving.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../lib/engine');

// --- Independent serial reference model -----------------------------------
// A straightforward, deliberately separate implementation of the same
// semantics: idem dedup + payload conflict, virtual-clock expiry, credit
// hold/capture/release, out-of-order buffering, compensating reversal.
function referenceRun(msgs, { limit, ttl: defaultTtl }) {
  let held = 0;
  let captured = 0;
  let now = 0;
  const auths = new Map();
  const caps = new Map();
  const byAuth = new Map();
  const seen = new Map();
  const pending = new Map();
  const ledger = [];
  const rejected = [];
  const avail = () => limit - held - captured;
  const key = (m) => JSON.stringify(m, Object.keys(m).sort());

  function ev(type, m, amount) {
    ledger.push({
      type,
      idemKey: m.idemKey,
      ref: m.ref === undefined ? null : m.ref,
      amount,
      available: avail(),
    });
  }
  function expire() {
    for (const a of auths.values()) {
      if (a.status === 'OPEN' && a.ts + a.ttl <= now) {
        a.status = 'VOID';
        held -= a.amount;
        ev('auto_void', { idemKey: a.key }, a.amount);
      }
    }
  }
  function reject(m, reason, fromBuffer) {
    rejected.push({ idemKey: m.idemKey, reason });
    if (!fromBuffer) seen.set(m.idemKey, key(m));
  }
  function buffer(m) {
    if (!pending.has(m.ref)) pending.set(m.ref, []);
    pending.get(m.ref).push(m);
  }
  function drain(k) {
    const list = pending.get(k);
    if (!list) return;
    pending.delete(k);
    list.sort((x, y) => x.seq - y.seq);
    for (const m of list) step(m, true);
  }
  function step(m, fromBuffer) {
    if (m.type === 'auth') {
      if (avail() < m.amount) return reject(m, 'insufficient-credit', fromBuffer);
      const a = {
        key: m.idemKey,
        amount: m.amount,
        ts: m.ts,
        ttl: m.ttl === undefined ? defaultTtl : m.ttl,
        status: 'OPEN',
      };
      auths.set(a.key, a);
      held += a.amount;
      ev('auth', m, a.amount);
      drain(a.key);
    } else if (m.type === 'capture') {
      const a = auths.get(m.ref);
      if (!a) return buffer(m);
      if (a.status !== 'OPEN') return reject(m, 'auth-' + a.status.toLowerCase(), fromBuffer);
      const amount = m.amount === undefined ? a.amount : m.amount;
      if (amount > a.amount) return reject(m, 'capture-exceeds-auth', fromBuffer);
      held -= a.amount;
      captured += amount;
      a.status = 'CAPTURED';
      const cap = { key: m.idemKey, authKey: a.key, amount, refunded: 0 };
      caps.set(cap.key, cap);
      byAuth.set(a.key, cap);
      ev('capture', m, amount);
      drain(cap.key);
    } else if (m.type === 'void') {
      const a = auths.get(m.ref);
      if (!a) return buffer(m);
      if (a.status === 'VOID') return reject(m, 'already-void', fromBuffer);
      if (a.status === 'CAPTURED') return reject(m, 'already-captured', fromBuffer);
      held -= a.amount;
      a.status = 'VOID';
      ev('void', m, a.amount);
    } else { // refund | reversal
      const cap = caps.get(m.ref) || byAuth.get(m.ref);
      if (!cap) {
        if (auths.has(m.ref)) return reject(m, 'not-captured', fromBuffer);
        return buffer(m);
      }
      const remaining = cap.amount - cap.refunded;
      const amount = m.amount === undefined ? remaining : m.amount;
      if (amount > remaining) return reject(m, m.type + '-exceeds-capture', fromBuffer);
      cap.refunded += amount;
      captured -= amount;
      ev(m.type, m, amount);
    }
  }
  for (const m of msgs) {
    const k = key(m);
    if (seen.has(m.idemKey)) {
      if (seen.get(m.idemKey) !== k) rejected.push({ idemKey: m.idemKey, reason: 'idem-key-conflict' });
      continue;
    }
    if (m.ts > now) now = m.ts;
    expire();
    seen.set(m.idemKey, k);
    step(m, false);
  }
  return { available: avail(), held, captured, ledger, rejected };
}

// --- Engine outcome, normalized to the reference shape --------------------
function engineRun(msgs, opts) {
  const e = new Engine(opts);
  for (const m of msgs) e.apply(m);
  const f = e.finalize();
  return {
    available: f.available,
    held: f.held,
    captured: f.captured,
    ledger: f.ledger.map((ev) => ({
      type: ev.type, idemKey: ev.idemKey, ref: ev.ref, amount: ev.amount, available: ev.available,
    })),
    rejected: f.certificate.rejected,
  };
}

function* permutations(arr) {
  if (arr.length <= 1) { yield arr.slice(); return; }
  for (let i = 0; i < arr.length; i++) {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) {
      p.unshift(arr[i]);
      yield p;
    }
  }
}

function checkAllInterleavings(name, ops, opts) {
  test('acceptance 4: exhaustive interleavings match serial reference: ' + name, () => {
    assert.ok(ops.length <= 6);
    let count = 0;
    for (const perm of permutations(ops)) {
      const expected = referenceRun(perm, opts);
      const actual = engineRun(perm, opts);
      assert.deepEqual(actual, expected, 'divergence for order: ' + perm.map((m) => m.idemKey).join(','));
      count += 1;
    }
    assert.equal(count, 720); // 6! interleavings
  });
}

const OPTS_A = { limit: 1000, ttl: 100000 };
checkAllInterleavings('auth/capture/void/refund/reversal contention', [
  { idemKey: 'a1', type: 'auth', amount: 400, seq: 1, ts: 10 },
  { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 150, seq: 2, ts: 20 },
  { idemKey: 'v1', type: 'void', ref: 'a1', seq: 3, ts: 30 },
  { idemKey: 'r1', type: 'refund', ref: 'c1', amount: 50, seq: 4, ts: 40 },
  { idemKey: 'a2', type: 'auth', amount: 700, seq: 5, ts: 50 },
  { idemKey: 'x1', type: 'reversal', ref: 'c1', amount: 100, seq: 6, ts: 60 },
], OPTS_A);

const OPTS_B = { limit: 1000, ttl: 100000 };
checkAllInterleavings('expiry race and credit-limit contention', [
  { idemKey: 'a1', type: 'auth', amount: 300, seq: 1, ts: 100, ttl: 50 },
  { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 300, seq: 2, ts: 120 },
  { idemKey: 'c2', type: 'capture', ref: 'a1', amount: 100, seq: 3, ts: 200 },
  { idemKey: 'a2', type: 'auth', amount: 800, seq: 4, ts: 210 },
  { idemKey: 'v1', type: 'void', ref: 'a2', seq: 5, ts: 220 },
  { idemKey: 'r1', type: 'refund', ref: 'c1', amount: 300, seq: 6, ts: 230 },
], OPTS_B);

const OPTS_C = { limit: 1000, ttl: 100000 };
const dupC1 = { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 80, seq: 2, ts: 20 };
checkAllInterleavings('resent duplicate delivery among concurrent ops', [
  { idemKey: 'a1', type: 'auth', amount: 100, seq: 1, ts: 10 },
  dupC1,
  Object.assign({}, dupC1), // exact resend on the same connection
  { idemKey: 'r1', type: 'refund', ref: 'c1', amount: 30, seq: 4, ts: 40 },
  { idemKey: 'a2', type: 'auth', amount: 950, seq: 5, ts: 50 },
  { idemKey: 'x1', type: 'reversal', ref: 'c1', seq: 6, ts: 60 },
], OPTS_C);

// Acceptance 4 (extended): for every interleaving, crash after each possible
// WAL append, recover from the WAL, resend the full stream, and require the
// same outcome as the serial reference.
test('acceptance 4: crash recovery at every WAL append point matches reference', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const ops = [
    { idemKey: 'a1', type: 'auth', amount: 400, seq: 1, ts: 10 },
    { idemKey: 'c1', type: 'capture', ref: 'a1', amount: 150, seq: 2, ts: 20 },
    { idemKey: 'v1', type: 'void', ref: 'a1', seq: 3, ts: 30 },
    { idemKey: 'r1', type: 'refund', ref: 'c1', amount: 50, seq: 4, ts: 40 },
    { idemKey: 'a2', type: 'auth', amount: 700, seq: 5, ts: 50 },
    { idemKey: 'x1', type: 'reversal', ref: 'c1', amount: 100, seq: 6, ts: 60 },
  ];
  const wal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'walx-')), 'wal.jsonl');
  let runs = 0;
  for (const perm of permutations(ops)) {
    const expected = referenceRun(perm, OPTS_A);
    for (let crashAt = 1; crashAt <= ops.length; crashAt += 1) {
      const crashed = new Engine({
        limit: OPTS_A.limit,
        ttl: OPTS_A.ttl,
        walPath: wal,
        fresh: true,
        onAppend: (n) => { if (n === crashAt) throw new Error('crash'); },
      });
      let crashedAt = -1;
      for (let i = 0; i < perm.length; i += 1) {
        try {
          crashed.apply(perm[i]);
        } catch {
          crashedAt = i;
          break;
        }
      }
      // Restart: recover from WAL, resend the whole stream.
      const recovered = new Engine({ limit: OPTS_A.limit, ttl: OPTS_A.ttl, walPath: wal });
      for (const m of perm) recovered.apply(m);
      const f = recovered.finalize();
      const actual = {
        available: f.available,
        held: f.held,
        captured: f.captured,
        ledger: f.ledger.map((ev) => ({
          type: ev.type, idemKey: ev.idemKey, ref: ev.ref, amount: ev.amount, available: ev.available,
        })),
        rejected: f.certificate.rejected,
      };
      assert.deepEqual(actual, expected, 'divergence after crash for order: '
        + perm.map((m) => m.idemKey).join(',') + ' crashAt=' + crashAt + ' crashedAt=' + crashedAt);
      runs += 1;
    }
  }
  assert.equal(runs, 720 * 6);
});
