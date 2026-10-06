import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { check } from '../src/checker.js';
import { TypeCheckError } from '../src/errors.js';

function checkSrc(src) {
  const ast = parse(src);
  return check(ast);
}

const BASE = `rule "T" version 1 {
  param n: quantity
  param p: ratio
  param lvl: defect_level
  decide {
    when n >= 1 -> ACCEPT
    otherwise -> CONTINUE
  }
}`;

test('accepts a well-typed rule and reports slots', () => {
  const info = checkSrc(BASE);
  assert.equal(info.params.length, 3);
  assert.ok(info.slots >= 3);
});

test('rejects comparing quantity with ratio', () => {
  assert.throws(() => checkSrc(`rule "T" version 1 {
    param n: quantity
    decide { when n >= 5% -> ACCEPT otherwise -> CONTINUE }
  }`), (err) => {
    assert.ok(err instanceof TypeCheckError);
    assert.equal(err.line, 3);
    return true;
  });
});

test('defect_level comparisons are typed and ordered', () => {
  const info = checkSrc(`rule "T" version 1 {
    param lvl: defect_level
    decide {
      when lvl >= critical -> REJECT
      when lvl == none -> ACCEPT
      otherwise -> CONTINUE
    }
  }`);
  assert.ok(info.slots >= 1);
});

test('rejects defect_level compared with quantity', () => {
  assert.throws(() => checkSrc(`rule "T" version 1 {
    param lvl: defect_level
    decide { when lvl >= 2 -> REJECT otherwise -> CONTINUE }
  }`), TypeCheckError);
});

test('quantity / quantity yields a ratio usable against percents', () => {
  checkSrc(`rule "T" version 1 {
    param d: quantity
    param n: quantity
    decide { when d / n > 5% -> REJECT otherwise -> CONTINUE }
  }`);
});

test('let declared type must match expression type', () => {
  assert.throws(() => checkSrc(`rule "T" version 1 {
    param n: quantity
    let r: ratio = n + 1
    decide { when n >= 1 -> ACCEPT otherwise -> CONTINUE }
  }`), (err) => {
    assert.ok(err instanceof TypeCheckError);
    assert.equal(err.line, 3);
    return true;
  });
});

test('lexical scope: undefined name reports line; shadowing is allowed', () => {
  assert.throws(() => checkSrc(`rule "T" version 1 {
    param n: quantity
    decide { when missing >= 1 -> ACCEPT otherwise -> CONTINUE }
  }`), (err) => {
    assert.ok(err instanceof TypeCheckError);
    assert.equal(err.line, 3);
    return true;
  });
  // later let shadows the param; earlier lets still see the param
  const info = checkSrc(`rule "T" version 1 {
    param n: quantity
    let m: quantity = n + 1
    let n: quantity = m * 2
    decide { when n >= 1 -> ACCEPT otherwise -> CONTINUE }
  }`);
  assert.ok(info.slots >= 3);
});

test('decide-block lets are scoped to the block', () => {
  checkSrc(`rule "T" version 1 {
    param n: quantity
    decide {
      let t: quantity = n * 2
      when n >= t -> ACCEPT
      otherwise -> CONTINUE
    }
  }`);
});

test('non-boolean guard is rejected', () => {
  assert.throws(() => checkSrc(`rule "T" version 1 {
    param n: quantity
    decide { when n -> ACCEPT otherwise -> CONTINUE }
  }`), TypeCheckError);
});

test('and/or/not require booleans', () => {
  assert.throws(() => checkSrc(`rule "T" version 1 {
    param n: quantity
    decide { when n and n >= 1 -> ACCEPT otherwise -> CONTINUE }
  }`), TypeCheckError);
});
