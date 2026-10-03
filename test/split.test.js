'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { split, RATIOS, ORDER } = require('../src/split');

// Independent reference implementation written separately from src/split.js.
function referenceSplit(total) {
  const totalRatio = RATIOS.merchant + RATIOS.fee + RATIOS.tax;
  const base = ORDER.map((key) => Math.floor((total * RATIOS[key]) / totalRatio));
  const remainder = total - base.reduce((sum, value) => sum + value, 0);
  const ranked = ORDER
    .map((key, index) => ({ key, base: base[index], index }))
    .sort((a, b) => b.base - a.base || a.index - b.index);
  const result = Object.fromEntries(ORDER.map((key, index) => [key, base[index]]));
  for (let i = 0; i < remainder; i += 1) {
    result[ranked[i % ranked.length].key] += 1;
  }
  return {
    base: Object.fromEntries(ORDER.map((key, index) => [key, base[index]])),
    remainder,
    result,
  };
}

test('enumerate every integer total up to 5 yuan (500 cents)', () => {
  for (let total = 0; total <= 500; total += 1) {
    const shares = split(total);
    assert.equal(
      shares.merchant + shares.fee + shares.tax,
      total,
      `split of ${total} must sum to the total`
    );
    const reference = referenceSplit(total);
    assert.deepEqual(shares, reference.result, `split of ${total} must match reference`);
    // remainder is recomputable: total minus the floored base shares
    const remainder = total - (reference.base.merchant + reference.base.fee + reference.base.tax);
    assert.equal(remainder, reference.remainder);
    assert.ok(remainder >= 0 && remainder < ORDER.length);
    // the remainder is topped up one cent at a time on the largest base shares
    const extras = ORDER.map((key) => shares[key] - reference.base[key]);
    assert.ok(extras.every((extra) => extra === 0 || extra === 1), `extras for ${total}`);
    const ranked = ORDER.slice().sort(
      (a, b) => reference.base[b] - reference.base[a] || ORDER.indexOf(a) - ORDER.indexOf(b)
    );
    extras.forEach((extra, index) => {
      if (extra === 1) {
        assert.ok(
          ranked.indexOf(ORDER[index]) < remainder,
          `extra cent for ${ORDER[index]} at total ${total} must go to a largest base share`
        );
      }
    });
  }
});

test('fixed-ratio split examples', () => {
  assert.deepEqual(split(0), { merchant: 0, fee: 0, tax: 0 });
  assert.deepEqual(split(1), { merchant: 1, fee: 0, tax: 0 });
  assert.deepEqual(split(2), { merchant: 2, fee: 0, tax: 0 });
  assert.deepEqual(split(100), { merchant: 94, fee: 5, tax: 1 });
  assert.deepEqual(split(101), { merchant: 95, fee: 5, tax: 1 });
  assert.deepEqual(split(175), { merchant: 165, fee: 9, tax: 1 });
});

test('rejects negative and non-integer totals', () => {
  assert.throws(() => split(-1), TypeError);
  assert.throws(() => split(1.5), TypeError);
  assert.throws(() => split(NaN), TypeError);
});
