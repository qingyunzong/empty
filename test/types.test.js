'use strict';

const test = require('node:test');
const { compileSrc, expectErr } = require('./helpers');

test('money + rate is E_TYPE (no implicit conversion)', () => {
  expectErr(() => compileSrc('let x: money = 1m + 0.5;'), 'E_TYPE');
  expectErr(() => compileSrc('let x: rate = 0.5 + 1m;'), 'E_TYPE');
});

test('money * money is E_TYPE', () => {
  expectErr(() => compileSrc('let x: money = 1m * 2m;'), 'E_TYPE');
});

test('negative rate is E_TYPE', () => {
  const e = expectErr(() => compileSrc('let r: rate = -0.05;'), 'E_TYPE');
  assertMessage(e, /negative rates/);
  expectErr(() => compileSrc('let m: money = 100m * -0.05;'), 'E_TYPE');
});

test('declared type must match initializer', () => {
  expectErr(() => compileSrc('let x: money = 0.5;'), 'E_TYPE');
  expectErr(() => compileSrc('let x: rate = 1m;'), 'E_TYPE');
  expectErr(() => compileSrc('let x: bool = 1m < 0.5;'), 'E_TYPE');
});

test('if condition and branches are type checked', () => {
  expectErr(() => compileSrc('let x: money = if (1m) then 1m else 2m;'), 'E_TYPE');
  expectErr(() => compileSrc('let x: money = if (true) then 1m else 0.5;'), 'E_TYPE');
});

test('rule signature and return type are checked', () => {
  expectErr(() => compileSrc(
    'rule f(a: money) -> money { return 0.5; }'), 'E_TYPE');
  expectErr(() => compileSrc(
    'rule f(a: money) -> money { return a; }\nlet x: money = f(0.5);'), 'E_TYPE');
  expectErr(() => compileSrc(
    'rule f(a: money) -> money { return a; }\nlet x: money = f(1m, 2m);'), 'E_TYPE');
});

test('valid program passes the checker', () => {
  compileSrc(`
    let r: rate = 0.06;
    rule f(a: money, d: date) -> money {
      let x: money = round(a * r);
      return if (d >= 2026-01-01 and x > 0m) then x else 0m;
    }
  `);
});

function assertMessage(e, re) {
  if (!re.test(e.message)) throw new Error(`message '${e.message}' does not match ${re}`);
}
