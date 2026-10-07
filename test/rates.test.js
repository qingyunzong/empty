import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../src/rational.js';
import { checkRateConsistency, buildCertificate } from '../src/rates.js';
import { mulberry32, randInt, pick, bruteForceMinConflict } from './helpers.js';

const rate = (eid, pair, num, den = 1n) => {
  const [from, to] = pair.split('/');
  return { eid, pair, from, to, rate: Q.R(BigInt(num), BigInt(den)) };
};

test('consistent triangle passes', () => {
  const events = [
    rate('evt:1', 'USD/CNY', 7n),
    rate('evt:2', 'CNY/EUR', 1n, 7n),
    rate('evt:3', 'EUR/USD', 1n, 1n), // EUR = 7 CNY = 1 USD, consistent
  ];
  assert.ok(checkRateConsistency(events).ok);
});

test('contradictory triangle fails with exact ratios', () => {
  const events = [
    rate('evt:1', 'USD/CNY', 7n),
    rate('evt:2', 'CNY/EUR', 1n, 7n),
    rate('evt:3', 'EUR/USD', 1n, 2n),
  ];
  const res = checkRateConsistency(events);
  assert.equal(res.ok, false);
  assert.equal(Q.toString(res.conflict.implied), '1');
  assert.equal(Q.toString(res.conflict.asserted), '1/2');
});

test('self-loop and duplicate pair conflicts', () => {
  assert.equal(checkRateConsistency([rate('evt:1', 'USD/USD', 2n)]).ok, false);
  const dup = [rate('evt:1', 'USD/CNY', 7n), rate('evt:2', 'USD/CNY', 8n)];
  const cert = buildCertificate(dup);
  assert.deepEqual(cert.events, ['evt:1', 'evt:2']);
  assert.equal(cert.minimality, 'exact-minimum');
});

test('acceptance 3 (rates): random N<=8 vs brute-force minimum conflict', () => {
  const rng = mulberry32(20241008);
  const ccys = ['A', 'B', 'C', 'D'];
  for (let trial = 0; trial < 300; trial++) {
    const n = randInt(rng, 1, 8);
    const events = [];
    for (let i = 1; i <= n; i++) {
      const a = pick(rng, ccys);
      const b = rng() < 0.1 ? a : pick(rng, ccys.filter((c) => c !== a));
      events.push(rate(`evt:${i}`, `${a}/${b}`, BigInt(randInt(rng, 1, 9)), BigInt(randInt(rng, 1, 9))));
    }
    const res = checkRateConsistency(events);
    const brute = bruteForceMinConflict(events, checkRateConsistency);
    if (res.ok) {
      assert.equal(brute.size, 0, `trial ${trial}: engine ok but brute found conflict`);
    } else {
      assert.ok(brute.size > 0, `trial ${trial}: engine conflict but brute found none`);
      const cert = buildCertificate(events);
      assert.equal(cert.events.length, brute.size, `trial ${trial}: certificate is the exact minimum`);
      // certificate itself must be inconsistent and inclusion-minimal
      const subset = cert.events.map((eid) => events.find((e) => e.eid === eid));
      assert.equal(checkRateConsistency(subset).ok, false);
      for (let i = 0; i < subset.length; i++) {
        assert.ok(checkRateConsistency(subset.filter((_, j) => j !== i)).ok);
      }
    }
  }
});
