'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileSrc } = require('./helpers');
const { VM, fmtMoney } = require('../src/vm');

const RULES = `
let fee_rate: rate = 0.0015;
let vat_rate: rate = 0.06;
rule fee(amount: money, day: date) -> money {
  return round(amount * fee_rate);
}
rule tax(amount: money, day: date) -> money {
  return round(fee(amount, day) * vat_rate);
}
rule net(amount: money, day: date) -> money {
  return amount - fee(amount, day) - tax(amount, day);
}
`;

// Independent reference implementation: decimal rounding, half away from zero,
// written separately from the VM arithmetic.
function refRoundDiv(numerator, denominator) {
  let q = numerator / denominator;
  const rem = numerator % denominator;
  const absRem = rem < 0n ? -rem : rem;
  if (absRem * 2n >= denominator) q += rem < 0n ? -1n : 1n;
  return q;
}

function refResults(amountCents) {
  const fee = refRoundDiv(amountCents * 1500n, 1000000n);
  const tax = refRoundDiv(fee * 60000n, 1000000n);
  const net = amountCents - fee - tax;
  return { fee, tax, net };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('100 random flows match the independent rounding reference', () => {
  const prog = compileSrc(RULES);
  const vm = new VM(prog, []);
  const idx = {};
  prog.rules.forEach((r, i) => { idx[r.name] = i; });
  const rand = mulberry32(20261004);
  for (let n = 0; n < 100; n++) {
    const cents = BigInt(1 + Math.floor(rand() * 100000000));
    const day = 20000 + Math.floor(rand() * 1000);
    const amount = { t: 'money', v: cents };
    const date = { t: 'date', v: day };
    const fee = vm.callRule(idx.fee, [amount, date]);
    const tax = vm.callRule(idx.tax, [amount, date]);
    const net = vm.callRule(idx.net, [amount, date]);
    const ref = refResults(cents);
    assert.equal(fmtMoney(fee.v), fmtMoney(ref.fee), `fee mismatch for ${cents}`);
    assert.equal(fmtMoney(tax.v), fmtMoney(ref.tax), `tax mismatch for ${cents}`);
    assert.equal(fmtMoney(net.v), fmtMoney(ref.net), `net mismatch for ${cents}`);
  }
});

test('rounding is half away from zero on exact boundaries', () => {
  const prog = compileSrc(RULES);
  const vm = new VM(prog, []);
  const idx = {};
  prog.rules.forEach((r, i) => { idx[r.name] = i; });
  // 10.00 * 0.0015 = 0.015 -> exactly half a cent -> rounds up to 0.02
  const fee = vm.callRule(idx.fee, [{ t: 'money', v: 1000n }, { t: 'date', v: 20000 }]);
  assert.equal(fmtMoney(fee.v), '0.02');
});
