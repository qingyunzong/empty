// Acceptance 4: cross-check the ledger against an independent, deliberately
// naive script-style enumeration (plain [num, den] BigInt pairs, no shared
// code with src/), for randomized cases with N <= 10 items. Pure Node.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLedger } from '../src/ledger.js';

// --- independent naive rational machinery (intentionally not imported) ---
function nGcd(a, b) {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
function nReduce([n, d]) {
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = nGcd(n, d) || 1n;
  return [n / g, d / g];
}
function nAdd([an, ad], [bn, bd]) {
  return nReduce([an * bd + bn * ad, ad * bd]);
}
function nSub([an, ad], [bn, bd]) {
  return nReduce([an * bd - bn * ad, ad * bd]);
}
function nDiv([an, ad], [bn, bd]) {
  return nReduce([an * bd, ad * bn]);
}
function nFmt([n, d]) {
  return d === 1n ? `${n}` : `${n}/${d}`;
}

// Naive whole-set enumeration: walk every item, compute err = actual-claimed
// per item, accumulate sign-split sums over the audited stratum only.
function naiveBound(items, conf) {
  let neg = [0n, 1n];
  let pos = [0n, 1n];
  const witnesses = [];
  let audited = 0;
  for (const it of items) {
    if (it.actual === null) continue;
    audited += 1;
    const err = nSub(it.actual, it.claimed);
    if (err[0] < 0n) neg = nAdd(neg, err);
    else pos = nAdd(pos, err);
    if (err[0] !== 0n) witnesses.push(it.id);
  }
  return {
    audited,
    lower: nFmt(nDiv(neg, conf)),
    upper: nFmt(nDiv(pos, conf)),
    witnesses: witnesses.sort(),
  };
}

// Deterministic PRNG so failures are reproducible.
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

const CONFIDENCES = [[1n, 1n], [1n, 2n], [3n, 4n], [9n, 10n], [2n, 3n]];

test('acceptance 4: ledger matches naive enumeration for N<=10 (500 trials)', () => {
  const rand = mulberry32(0x5eed);
  const ri = (lo, hi) => lo + BigInt(Math.floor(rand() * Number(hi - lo + 1n)));
  for (let trial = 0; trial < 500; trial += 1) {
    const n = 1 + Math.floor(rand() * 10); // N in [1,10]
    const items = [];
    const ledger = new AuditLedger();
    for (let i = 0; i < n; i += 1) {
      const claimed = [ri(-50n, 200n), ri(1n, 9n)];
      const id = `it${i}`;
      ledger.addItem({ id, claimedNum: claimed[0], claimedDen: claimed[1] });
      const audited = rand() < 0.7;
      const actual = audited ? [ri(-50n, 200n), ri(1n, 9n)] : null;
      if (audited) ledger.audit({ id, actualNum: actual[0], actualDen: actual[1] });
      items.push({ id, claimed, actual });
    }
    // Randomly correct one item (audited or not) before bounding.
    const victim = items[Math.floor(rand() * items.length)];
    const newClaimed = [ri(-50n, 200n), ri(1n, 9n)];
    ledger.correct({ id: victim.id, newClaimed: `${newClaimed[0]}/${newClaimed[1]}` });
    victim.claimed = newClaimed;

    const conf = CONFIDENCES[Math.floor(rand() * CONFIDENCES.length)];
    const expected = naiveBound(items, conf);
    if (expected.audited === 0) {
      assert.throws(
        () => ledger.bound({ confidenceNum: conf[0], confidenceDen: conf[1] }),
        (e) => e.code === 'E_LAYER',
      );
      continue;
    }
    const bound = ledger.bound({ confidenceNum: conf[0], confidenceDen: conf[1] });
    assert.equal(bound.lower, expected.lower, `lower mismatch, trial ${trial}`);
    assert.equal(bound.upper, expected.upper, `upper mismatch, trial ${trial}`);
    assert.deepEqual(bound.witnessIds, expected.witnesses, `witnesses mismatch, trial ${trial}`);
    const anyPending = items.some((it) => it.actual === null);
    assert.equal(bound.status, anyPending ? 'pending' : 'ok');
    if (anyPending) assert.equal(bound.code, 'E_PENDING');

    // explain() stratum sums must match the un-inflated naive sums.
    const exact = naiveBound(items, [1n, 1n]);
    const exp = ledger.explain();
    assert.equal(exp.strata.audited.lower, exact.lower, `explain lower, trial ${trial}`);
    assert.equal(exp.strata.audited.upper, exact.upper, `explain upper, trial ${trial}`);
    assert.equal(ledger.verify(exp), true);
  }
});
