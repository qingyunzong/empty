import test from 'node:test';
import assert from 'node:assert/strict';
import { runNetting } from '../src/engine.js';
import { NetError } from '../src/errors.js';

const OBS = [
  { id: 'o1', debtor: 'M1', creditor: 'M2', ccy: 'USD', amount: 100, date: '2026-10-02' },
];

function codeOf(rules, obs = OBS) {
  try {
    runNetting(rules, obs);
    return null;
  } catch (e) {
    assert.ok(e instanceof NetError, `expected NetError, got ${e}`);
    return e.code;
  }
}

test('E_CCY: statically adding different currencies is rejected', () => {
  const rules = 'date 2026-10-02 { const x = 100 USD + 200 EUR; }';
  assert.equal(codeOf(rules), 'E_CCY');
});

test('E_CCY: currency mismatch through the gross amount field', () => {
  const rules = 'date 2026-10-02 { filter amount + 1 EUR > 2 USD; }';
  assert.equal(codeOf(rules), 'E_CCY');
});

test('E_TYPE: net position cannot be used as gross in a filter', () => {
  const rules = 'date 2026-10-02 { filter position > 0; }';
  assert.equal(codeOf(rules), 'E_TYPE');
});

test('E_TYPE: gross amount cannot be used as net in a settle expression', () => {
  const rules = 'date 2026-10-02 { settle x = amount; }';
  assert.equal(codeOf(rules), 'E_TYPE');
});

test('E_SCOPE: constants are scoped per trade date, cross-date reference forbidden', () => {
  const rules = `
    date 2026-10-01 { const cap = 100; }
    date 2026-10-02 { filter amount >= 2026-10-01.cap; }`;
  assert.equal(codeOf(rules), 'E_SCOPE');
});

test('same-date constant reference works', () => {
  const rules = `
    date 2026-10-02 {
      const cap = 100;
      filter amount >= cap;
    }`;
  const r = runNetting(rules, OBS);
  assert.equal(r.obligations, 1);
});

test('E_PARSE: unknown identifier and syntax errors', () => {
  assert.equal(codeOf('date 2026-10-02 { filter nosuch > 1; }'), 'E_PARSE');
  assert.equal(codeOf('date 2026-10-02 { filter amount >= ; }'), 'E_PARSE');
  assert.equal(codeOf('date 2026-10-02 { const x = 1 }'), 'E_PARSE');
});
