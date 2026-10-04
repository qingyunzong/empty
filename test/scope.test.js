'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileSrc, expectErr } = require('./helpers');
const { VM } = require('../src/vm');

test('duplicate let is E_SCOPE', () => {
  const e = expectErr(() => compileSrc('let x: money = 1m;\nlet x: money = 2m;'), 'E_SCOPE');
  assert.match(e.message, /duplicate/);
  assert.equal(e.line, 2);
});

test('duplicate let inside a rule is E_SCOPE', () => {
  expectErr(() => compileSrc(
    'rule f(a: money) -> money { let x: money = 1m; let x: money = 2m; return x; }'), 'E_SCOPE');
});

test('duplicate param is E_SCOPE', () => {
  expectErr(() => compileSrc(
    'rule f(a: money, a: money) -> money { return a; }'), 'E_SCOPE');
});

test('unbound variable is E_SCOPE', () => {
  const e = expectErr(() => compileSrc('let x: money = y + 1m;'), 'E_SCOPE');
  assert.match(e.message, /unbound variable 'y'/);
});

test('call to unknown rule is E_SCOPE', () => {
  expectErr(() => compileSrc('let x: money = nope(1m);'), 'E_SCOPE');
});

test('rule parameter shadows global let', () => {
  const prog = compileSrc(`
    let factor: money = 999m;
    rule f(factor: money, day: date) -> money { return factor + 1m; }
  `);
  const vm = new VM(prog, []);
  const out = vm.callRule(0, [{ t: 'money', v: 500n }, { t: 'date', v: 20000 }]);
  assert.deepEqual(out, { t: 'money', v: 600n });
});

test('rule body let shadows nothing outside its scope', () => {
  expectErr(() => compileSrc(`
    rule f(a: money) -> money { let tmp: money = a; return tmp; }
    let x: money = tmp;
  `), 'E_SCOPE');
});
