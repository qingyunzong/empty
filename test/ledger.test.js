import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLedger, AuditError } from '../src/ledger.js';

// ---------------------------------------------------------------------------
// Independent rational arithmetic for cross-checking. Deliberately does NOT
// import from src/ so the enumeration logic stays independent.
// ---------------------------------------------------------------------------
function igcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}
function irat(n, d = 1n) {
  if (d < 0n) [n, d] = [-n, -d];
  const g = igcd(n, d);
  return [n / g, d / g];
}
function iadd(a, b) {
  return irat(a[0] * b[1] + b[0] * a[1], a[1] * b[1]);
}
function ifmt(a) {
  return `${a[0]}/${a[1]}`;
}

// Enumerates the exact bound independently: for every audited item take
// diff = actual - claimed, then sum min(0,diff) and max(0,diff).
function enumerateBound(items) {
  let lower = [0n, 1n];
  let upper = [0n, 1n];
  const witnessIds = [];
  let pending = false;
  for (const item of items) {
    if (!item.audited) {
      pending = true;
      continue;
    }
    const diff = irat(
      item.actual[0] * item.claimed[1] - item.claimed[0] * item.actual[1],
      item.actual[1] * item.claimed[1],
    );
    if (diff[0] < 0n) lower = iadd(lower, diff);
    if (diff[0] > 0n) upper = iadd(upper, diff);
    if (diff[0] !== 0n) witnessIds.push(item.id);
  }
  return {
    lower: ifmt(lower),
    upper: ifmt(upper),
    status: pending ? 'E_PENDING' : 'OK',
    witnessIds,
  };
}

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

function buildLedger(items) {
  const ledger = new AuditLedger();
  for (const item of items) {
    ledger.addItem({ id: item.id, claimedNum: item.claimed[0], claimedDen: item.claimed[1] });
    if (item.audited) {
      ledger.audit({ id: item.id, actualNum: item.actual[0], actualDen: item.actual[1] });
    }
  }
  return ledger;
}

// Acceptance 1: fully audited population -> interval equals the exact sum.
test('full audit equals exact rational sum', () => {
  const items = [
    { id: 'a', claimed: irat(3n, 2n), actual: irat(1n, 1n), audited: true },
    { id: 'b', claimed: irat(7n, 4n), actual: irat(9n, 4n), audited: true },
    { id: 'c', claimed: irat(5n, 3n), actual: irat(5n, 3n), audited: true },
    { id: 'd', claimed: irat(11n, 6n), actual: irat(2n, 1n), audited: true },
  ];
  const ledger = buildLedger(items);
  const got = ledger.bound({ confidenceNum: 19, confidenceDen: 20 });
  const want = enumerateBound(items);
  assert.equal(got.status, 'OK');
  assert.equal(got.lower, want.lower);
  assert.equal(got.upper, want.upper);
  assert.deepEqual(got.witnessIds, want.witnessIds);
});

// Acceptance 2: partial audit -> E_PENDING, unaudited items excluded.
test('partial audit is pending and excludes unaudited items', () => {
  const items = [
    { id: 'a', claimed: irat(10n, 1n), actual: irat(4n, 1n), audited: true },
    { id: 'b', claimed: irat(999n, 1n), actual: null, audited: false },
    { id: 'c', claimed: irat(1n, 2n), actual: irat(3n, 2n), audited: true },
  ];
  const ledger = buildLedger(items);
  const got = ledger.bound({ confidenceNum: 95, confidenceDen: 100 });
  const want = enumerateBound(items);
  assert.equal(got.status, 'E_PENDING');
  assert.equal(got.lower, want.lower);
  assert.equal(got.upper, want.upper);
  assert.deepEqual(got.witnessIds, ['a', 'c']);
  assert.ok(!got.witnessIds.includes('b'));
  // Auditing the pending item later (supplementary sampling) resolves it.
  ledger.audit({ id: 'b', actualNum: 999, actualDen: 1 });
  const done = ledger.bound({ confidenceNum: 95, confidenceDen: 100 });
  assert.equal(done.status, 'OK');
});

// Acceptance 3: correcting an audited item invalidates prior explain output.
test('correct invalidates old explain certificate', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'a', claimedNum: 5, claimedDen: 1 });
  ledger.audit({ id: 'a', actualNum: 3, actualDen: 1 });
  const cert = ledger.explain();
  assert.equal(ledger.verifyExplain(cert), true);
  const before = ledger.bound({ confidenceNum: 9, confidenceDen: 10 });
  assert.equal(before.lower, '-2/1');

  ledger.correct({ id: 'a', newClaimed: '4/1' });
  assert.equal(ledger.verifyExplain(cert), false);
  const after = ledger.bound({ confidenceNum: 9, confidenceDen: 10 });
  assert.equal(after.lower, '-1/1');
  const fresh = ledger.explain();
  assert.equal(ledger.verifyExplain(fresh), true);
  assert.notEqual(fresh.head, cert.head);
});

// Acceptance 4: randomized N<=10 cross-check against independent enumeration.
test('randomized cross-check against independent enumeration (N<=10)', () => {
  const rand = mulberry32(20261004);
  const ri = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  for (let trial = 0; trial < 200; trial += 1) {
    const n = ri(1, 10);
    const items = [];
    for (let i = 0; i < n; i += 1) {
      const audited = rand() < 0.7;
      items.push({
        id: `i${i}`,
        claimed: irat(BigInt(ri(-50, 200)), BigInt(ri(1, 12))),
        actual: audited ? irat(BigInt(ri(-50, 200)), BigInt(ri(1, 12))) : null,
        audited,
      });
    }
    const ledger = buildLedger(items);
    const got = ledger.bound({ confidenceNum: 99, confidenceDen: 100 });
    const want = enumerateBound(items);
    assert.equal(got.status, want.status, `trial ${trial} status`);
    assert.equal(got.lower, want.lower, `trial ${trial} lower`);
    assert.equal(got.upper, want.upper, `trial ${trial} upper`);
    assert.deepEqual(got.witnessIds, want.witnessIds, `trial ${trial} witnesses`);
  }
});

test('E_LAYER on empty population', () => {
  const ledger = new AuditLedger();
  assert.throws(() => ledger.bound({ confidenceNum: 1, confidenceDen: 2 }), (err) => {
    assert.ok(err instanceof AuditError);
    assert.equal(err.code, 'E_LAYER');
    return true;
  });
  assert.throws(() => ledger.explain(), (err) => err.code === 'E_LAYER');
});

test('E_CONF for confidence outside (0,1)', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'a', claimedNum: 1, claimedDen: 1 });
  for (const [num, den] of [
    [0, 1],
    [1, 1],
    [3, 2],
    [-1, 2],
  ]) {
    assert.throws(
      () => ledger.bound({ confidenceNum: num, confidenceDen: den }),
      (err) => err.code === 'E_CONF',
    );
  }
});

test('duplicate and unknown items are rejected', () => {
  const ledger = new AuditLedger();
  ledger.addItem({ id: 'a', claimedNum: 1, claimedDen: 1 });
  assert.throws(() => ledger.addItem({ id: 'a', claimedNum: 2 }), (err) => err.code === 'E_DUP');
  assert.throws(() => ledger.audit({ id: 'nope', actualNum: 1 }), (err) => err.code === 'E_ITEM');
  assert.throws(() => ledger.correct({ id: 'nope', newClaimed: '1/1' }), (err) => err.code === 'E_ITEM');
});
