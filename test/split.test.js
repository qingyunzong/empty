import test from 'node:test';
import assert from 'node:assert/strict';
import { splitAmount, SPLIT_RULE } from '../src/split.js';

// Independent recomputation used only by tests: floor shares, then hand the
// remainder to the largest shares one cent at a time.
function referenceSplit(total) {
  const shares = SPLIT_RULE.map((r) => Math.floor((total * r.basisPoints) / 10000));
  let remainder = total - shares.reduce((a, b) => a + b, 0);
  const order = shares
    .map((amount, index) => ({ amount, index }))
    .sort((x, y) => y.amount - x.amount || x.index - y.index);
  const out = [...shares];
  for (let i = 0; remainder > 0; remainder -= 1, i += 1) out[order[i].index] += 1;
  return { merchant: out[0], fee: out[1], tax: out[2] };
}

test('enumerates every integer total up to 5 yuan (500 cents): sum is conserved and remainder recomputable', () => {
  for (let total = 0; total <= 500; total += 1) {
    const split = splitAmount(total);
    assert.equal(split.merchant + split.fee + split.tax, total, `total=${total} not conserved`);
    assert.ok(split.merchant >= 0 && split.fee >= 0 && split.tax >= 0);
    const expected = referenceSplit(total);
    assert.deepEqual(
      { merchant: split.merchant, fee: split.fee, tax: split.tax },
      expected,
      `total=${total} remainder distribution mismatch`,
    );
  }
});

test('remainder goes to the largest share (descending amount, +1 cent each)', () => {
  assert.deepEqual(splitAmount(100), { total: 100, merchant: 94, fee: 4, tax: 2 });
  // floors: 94/4/2 -> remainder 1 -> merchant is largest
  assert.deepEqual(splitAmount(101), { total: 101, merchant: 95, fee: 4, tax: 2 });
  // floors of 103: 96.82->96? no: 103*0.94=96.82->96, 4.12->4, 2.06->2 => 102, remainder 1 -> merchant
  assert.deepEqual(splitAmount(103), { total: 103, merchant: 97, fee: 4, tax: 2 });
  assert.deepEqual(splitAmount(0), { total: 0, merchant: 0, fee: 0, tax: 0 });
});

test('rejects negative and non-integer totals', () => {
  assert.throws(() => splitAmount(-1), (err) => err.code === 'INVALID_AMOUNT');
  assert.throws(() => splitAmount(1.5), (err) => err.code === 'INVALID_AMOUNT');
  assert.throws(() => splitAmount(Number.NaN), (err) => err.code === 'INVALID_AMOUNT');
});
