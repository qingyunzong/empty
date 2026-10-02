import test from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/lexer.js';
import { runNetting } from '../src/engine.js';

const OBS = [
  { id: 'o1', debtor: 'M1', creditor: 'M2', ccy: 'USD', amount: 250, date: '2026-10-02' },
  { id: 'o2', debtor: 'M2', creditor: 'M3', ccy: 'USD', amount: 400, date: '2026-10-02' },
  { id: 'o3', debtor: 'M3', creditor: 'M1', ccy: 'EUR', amount: 500, date: '2026-10-02' },
];

test('lexer: members, currencies, obligation ids, percentages, dates', () => {
  const toks = lex('date 2026-10-02 { filter debtor == @M1 and id != #o9 and ccy == USD and amount * 2.5% > 0; }');
  const types = toks.map((t) => t.t);
  assert.ok(types.includes('MEMBER'));
  assert.ok(types.includes('OBID'));
  assert.ok(types.includes('CCY'));
  assert.ok(types.includes('PCT'));
  assert.ok(types.includes('DATE'));
  assert.equal(toks.find((t) => t.t === 'MEMBER').v, 'M1');
  assert.equal(toks.find((t) => t.t === 'OBID').v, 'o9');
  assert.equal(toks.find((t) => t.t === 'PCT').v, 250); // 2.5% = 250bps, integer only
});

test('pratt parser: precedence of and/or/not and comparisons', () => {
  const rules = `
    date 2026-10-02 {
      filter amount >= 300 or ccy == EUR and not amount >= 1000;
    }`;
  // parses as: amount>=300 or (ccy==EUR and (not amount>=1000))
  const r = runNetting(rules, OBS);
  assert.equal(r.obligations, 2); // o2 (400 USD), o3 (500 EUR) kept; o1 (250) dropped
  assert.deepEqual(Object.keys(r.currencies).sort(), ['EUR', 'USD']);
});

test('min/max/abs compile to bytecode and evaluate as integer math', () => {
  const rules = `
    date 2026-10-02 {
      const cap = max(100, 50) + min(200, 300);
      filter abs(amount) >= cap;
    }`;
  const r = runNetting(rules, OBS);
  assert.equal(r.obligations, 2); // cap = 300, keeps o2 (400) and o3 (500)
});

test('percentage arithmetic on money stays in integer cents', () => {
  const rules = `
    date 2026-10-02 {
      const fee = 2.5%;
      filter amount * fee >= 10;
    }`;
  const r = runNetting(rules, OBS);
  // 250*250/10000 = 6 (dropped), 400*250/10000 = 10 (kept), 500*... = 12 (kept)
  assert.equal(r.obligations, 2);
});

test('member and obligation-id literals usable in filters', () => {
  const rules = `
    date 2026-10-02 {
      filter debtor != @M1 and id != #o3;
    }`;
  const r = runNetting(rules, OBS);
  assert.equal(r.obligations, 1); // only o2 survives
});

test('settle expression runs per member on net positions', () => {
  const rules = `
    date 2026-10-02 {
      filter amount >= 1;
      settle fee = min(abs(position) * 1%, 500);
    }`;
  const r = runNetting(rules, OBS);
  const fees = r.currencies.USD.settle.filter((s) => s.name === 'fee');
  assert.ok(fees.length > 0);
  for (const f of fees) assert.ok(Number.isSafeInteger(f.value.amount));
});
