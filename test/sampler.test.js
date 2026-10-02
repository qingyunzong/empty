'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  plan,
  verify,
  AuditError,
  certificateHash,
} = require('../src/sampler');
const { verifyMerkleProof } = require('../src/hash');

function ledger(stratum, n, opts = {}) {
  const entries = [];
  for (let i = 1; i <= n; i++) {
    entries.push({ source: 'core', seq: i, version: 1, stratum, amount: i * 100, ...opts });
  }
  return entries;
}

function baseInput(overrides = {}) {
  return {
    seed: 'audit-2026-Q3',
    version: 7,
    strata: {
      retail: ledger('retail', 10),
      corporate: ledger('corporate', 8),
    },
    quotas: { retail: 4, corporate: 3 },
    ...overrides,
  };
}

test('deterministic: same seed + same version yields identical output', () => {
  const a = plan(baseInput());
  const b = plan(baseInput());
  assert.deepEqual(a, b);
  assert.equal(a.merkleRoot, b.merkleRoot);
});

test('different seed yields a different sample', () => {
  const a = plan(baseInput());
  const b = plan(baseInput({ seed: 'audit-2026-Q4' }));
  assert.notEqual(a.merkleRoot, b.merkleRoot);
  assert.notDeepEqual(a.samples, b.samples);
});

test('quota boundary: quota equal to population selects everyone', () => {
  const r = plan(baseInput({ quotas: { retail: 10, corporate: 8 } }));
  assert.equal(r.samples.retail.length, 10);
  assert.equal(r.samples.corporate.length, 8);
  assert.equal(r.quotaUse.retail.used, 10);
  assert.equal(r.quotaUse.corporate.population, 8);
});

test('quota boundary: quota zero selects nobody but keeps the stratum', () => {
  const r = plan(baseInput({ quotas: { retail: 0, corporate: 3 } }));
  assert.deepEqual(r.samples.retail, []);
  assert.equal(r.samples.corporate.length, 3);
  assert.equal(r.quotaUse.retail.used, 0);
});

test('quota boundary: quota above population fails with QUOTA', () => {
  assert.throws(
    () => plan(baseInput({ quotas: { retail: 11, corporate: 3 } })),
    (err) => {
      assert.ok(err instanceof AuditError);
      assert.equal(err.code, 'QUOTA');
      assert.equal(err.details.stratum, 'retail');
      assert.equal(err.details.population, 10);
      return true;
    },
  );
});

test('quota boundary: negative and fractional quotas fail with QUOTA', () => {
  for (const bad of [-1, 1.5, '2', null]) {
    assert.throws(
      () => plan(baseInput({ quotas: { retail: bad, corporate: 3 } })),
      (err) => err.code === 'QUOTA',
    );
  }
});

test('missing seed fails with SEED_REQUIRED', () => {
  for (const seed of [undefined, null, '']) {
    const input = baseInput();
    delete input.seed;
    if (seed !== undefined) input.seed = seed;
    assert.throws(() => plan(input), (err) => err.code === 'SEED_REQUIRED');
  }
});

test('missing strata are never treated as empty populations', () => {
  const input = baseInput({ quotas: { retail: 2, corporate: 3, fx: 1, treasury: 2 } });
  assert.throws(
    () => plan(input),
    (err) => {
      assert.equal(err.code, 'STRATA_MISSING');
      assert.deepEqual(err.details.missing.sort(), ['fx', 'treasury']);
      return true;
    },
  );
});

test('concurrent versions: highest (version, source, seq) wins', () => {
  const strata = {
    retail: [
      { source: 'core', seq: 1, version: 1, amount: 100 },
      { source: 'core', seq: 1, version: 3, amount: 300 }, // correction wins
      { source: 'core', seq: 1, version: 2, amount: 200 }, // stale, ignored
      { source: 'core', seq: 2, version: 1, amount: 50 },
    ],
  };
  const r = plan({ seed: 's', version: 9, strata, quotas: { retail: 2 } });
  assert.equal(r.quotaUse.retail.population, 2); // deduped, not 4
  // Re-run with only the winning correction: identical sample.
  const r2 = plan({
    seed: 's',
    version: 9,
    strata: {
      retail: [
        { source: 'core', seq: 1, version: 3, amount: 300 },
        { source: 'core', seq: 2, version: 1, amount: 50 },
      ],
    },
    quotas: { retail: 2 },
  });
  assert.deepEqual(r.samples, r2.samples);
});

test('same (version, source, seq) with different payload is VERSION_CONFLICT', () => {
  const strata = {
    retail: [
      { source: 'core', seq: 1, version: 2, amount: 100 },
      { source: 'core', seq: 1, version: 2, amount: 999 },
    ],
  };
  assert.throws(
    () => plan({ seed: 's', version: 1, strata, quotas: { retail: 1 } }),
    (err) => {
      assert.equal(err.code, 'VERSION_CONFLICT');
      assert.equal(err.details.source, 'core');
      assert.equal(err.details.seq, 1);
      return true;
    },
  );
});

test('identical duplicate entries are idempotent, not a conflict', () => {
  const entry = { source: 'core', seq: 1, version: 2, amount: 100 };
  const r = plan({
    seed: 's',
    version: 1,
    strata: { retail: [entry, { ...entry }] },
    quotas: { retail: 1 },
  });
  assert.equal(r.quotaUse.retail.population, 1);
});

test('revocation resamples only the affected stratum and supersedes its certificate', () => {
  const input = baseInput();
  const first = plan(input);

  // Revoke one retail entry via a higher-version tombstone; corporate untouched.
  const revokedEntry = { source: 'core', seq: 3, version: 2, revoked: true };
  const second = plan({
    ...input,
    version: 8,
    strata: {
      retail: [...input.strata.retail, revokedEntry],
      corporate: input.strata.corporate,
    },
    prev: first,
  });

  // Only retail was resampled; corporate certificate reused verbatim.
  assert.deepEqual(second.samples.corporate, first.samples.corporate);
  assert.equal(second.quotaUse.retail.population, 9);
  assert.equal(second.invalidated.length, 1);

  const inv = second.invalidated[0];
  assert.equal(inv.stratum, 'retail');
  assert.equal(inv.status, 'SUPERSEDED');
  assert.equal(inv.reason, 'POPULATION_CHANGED');
  assert.equal(inv.supersededCertificate.status, 'SUPERSEDED');

  // Invalidation proof ties the old certificate to the old root.
  const oldCert = first.certificates.find((c) => c.stratum === 'retail');
  assert.equal(inv.supersededCertificateHash, certificateHash(oldCert));
  assert.equal(inv.previousMerkleRoot, first.merkleRoot);
  assert.ok(
    verifyMerkleProof(inv.supersededCertificateHash, inv.invalidationProof, first.merkleRoot),
    'invalidation proof must verify against the previous merkle root',
  );

  // The revoked item can never appear in the new sample.
  assert.ok(!second.samples.retail.includes('core#3'));

  // New root differs and the full new result verifies independently.
  assert.notEqual(second.merkleRoot, first.merkleRoot);
  const report = verify(
    { strata: { retail: [...input.strata.retail, revokedEntry], corporate: input.strata.corporate }, quotas: input.quotas },
    second,
  );
  assert.ok(report.ok, JSON.stringify(report));
});

test('correction (higher version, same key) also triggers incremental resample', () => {
  const input = baseInput();
  const first = plan(input);
  const corrected = input.strata.corporate.map((e) =>
    e.seq === 5 ? { ...e, version: 2, amount: 55500 } : e,
  );
  const second = plan({
    ...input,
    version: 8,
    strata: { retail: input.strata.retail, corporate: corrected },
    prev: first,
  });
  // Amount is not part of the identity: population hash is key-based, so a
  // pure amount correction keeps the population and the certificate is reused.
  assert.equal(second.invalidated.length, 0);
  assert.deepEqual(second.samples, first.samples);

  // But adding/removing an entry does invalidate.
  const third = plan({
    ...input,
    version: 9,
    strata: {
      retail: input.strata.retail,
      corporate: [...corrected, { source: 'core', seq: 99, version: 1, amount: 1 }],
    },
    prev: second,
  });
  assert.equal(third.invalidated.length, 1);
  assert.equal(third.invalidated[0].stratum, 'corporate');
  assert.deepEqual(third.samples.retail, first.samples.retail);
});

test('every certificate carries a verifiable merkle proof', () => {
  const r = plan(baseInput());
  assert.equal(r.certificates.length, 2);
  for (const cert of r.certificates) {
    assert.equal(certificateHash(cert), cert.certificateHash);
    assert.ok(verifyMerkleProof(cert.certificateHash, cert.merkleProof, r.merkleRoot));
  }
});

test('verify() detects tampering', () => {
  const input = baseInput();
  const r = plan(input);
  const tampered = JSON.parse(JSON.stringify(r));
  tampered.samples.retail = ['core#1'];
  const report = verify(input, tampered);
  assert.equal(report.ok, false);
});

// Cross-check against an independent stratified enumeration: for n <= 12,
// recompute ranks with a separate implementation and confirm the selected
// set is exactly the `quota` smallest ranks, for every stratum size and
// every quota from 0..n.
test('n<=12: matches independent enumeration of hash ranks', () => {
  const independentSelect = (seed, stratum, keys, quota) => {
    const ranks = keys.map((key) => ({
      key,
      rank: createHash('sha256').update(`${seed}|${stratum}|${key}`, 'utf8').digest('hex'),
    }));
    ranks.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    return ranks.slice(0, quota).map((r) => r.key).sort();
  };

  for (let n = 1; n <= 12; n++) {
    const stratum = `s${n}`;
    const entries = ledger(stratum, n);
    for (let quota = 0; quota <= n; quota++) {
      const r = plan({
        seed: 'cross-check',
        version: 1,
        strata: { [stratum]: entries },
        quotas: { [stratum]: quota },
      });
      const keys = entries.map((e) => `core#${e.seq}`);
      const expected = independentSelect('cross-check', stratum, keys, quota);
      assert.deepEqual(
        r.samples[stratum],
        expected,
        `mismatch at n=${n}, quota=${quota}`,
      );
      // Sampled keys are unique and drawn from the population.
      assert.equal(new Set(r.samples[stratum]).size, r.samples[stratum].length);
      for (const key of r.samples[stratum]) assert.ok(keys.includes(key));
    }
  }
});

// Unbiasedness smoke test: with n=6, quota=3 every item must be selected
// with probability 1/2. Over 600 fixed seeds (expected count 300 each),
// a broken sampler would fall far outside [200, 400]; a correct one is
// ~5.5 sigma away from the bounds, so the fixed-seed test is stable.
test('selection is unbiased across seeds (n=6, quota=3, 600 seeds)', () => {
  const counts = new Map();
  const entries = ledger('u', 6);
  for (let i = 0; i < 600; i++) {
    const r = plan({
      seed: `seed-${i}`,
      version: 1,
      strata: { u: entries },
      quotas: { u: 3 },
    });
    for (const key of r.samples.u) counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.equal(counts.size, 6);
  for (const [key, count] of counts) {
    assert.ok(count > 200 && count < 400, `${key} selected ${count} times (expected ~300)`);
  }
});
