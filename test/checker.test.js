import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileContract } from '../src/runtime.js';

test('bps cannot be added to money directly (E_TYPE)', () => {
  const src = `
    class A { fee subscribe(amount: money) -> money {
      let x = 1bps + 2.00;
      return amount;
    } }
  `;
  assert.throws(() => compileContract(src), (e) => e.code === 'E_TYPE');
});

test('money * bps and units * money are money', () => {
  const src = `
    class A {
      fee subscribe(amount: money) -> money { return amount * 120bps; }
      fee redeem(shares: units, nav: money) -> money { return shares * nav; }
    }
  `;
  assert.doesNotThrow(() => compileContract(src));
});

test('invalid multiplication and comparisons raise E_TYPE', () => {
  assert.throws(() => compileContract(`
    class A { fee subscribe(amount: money) -> money { return amount * amount; } }
  `), (e) => e.code === 'E_TYPE');
  assert.throws(() => compileContract(`
    class A { fee subscribe(amount: money) -> money {
      let ok = amount < 7;
      return amount;
    } }
  `), (e) => e.code === 'E_TYPE');
});

test('return type must match declaration', () => {
  assert.throws(() => compileContract(`
    class A { fee subscribe(amount: money) -> money { return 120bps; } }
  `), (e) => e.code === 'E_TYPE');
});

test('unknown identifier raises E_NAME', () => {
  assert.throws(() => compileContract(`
    class A { fee subscribe(amount: money) -> money { return amount + missing; } }
  `), (e) => e.code === 'E_NAME');
});
