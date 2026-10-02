import test from 'node:test';
import assert from 'node:assert/strict';
import { runNetting } from '../src/engine.js';
import { assertUniqueCycles } from '../src/netting.js';
import { NetError } from '../src/errors.js';

const RULES = 'date 2026-10-02 { filter amount >= 1; }';
const ob = (id, amount, date = '2026-10-02') =>
  ({ id, debtor: 'M1', creditor: 'M2', ccy: 'USD', amount, date });

function codeOf(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof NetError, `expected NetError, got ${e}`);
    return e.code;
  }
}

test('E_NO_SOL: everything filtered out leaves nothing to settle', () => {
  const rules = 'date 2026-10-02 { filter amount > 1000000; }';
  assert.equal(codeOf(() => runNetting(rules, [ob('o1', 5)])), 'E_NO_SOL');
});

test('E_NO_SOL: empty obligation list', () => {
  assert.equal(codeOf(() => runNetting(RULES, [])), 'E_NO_SOL');
});

test('E_PARSE: duplicate obligation id', () => {
  assert.equal(codeOf(() => runNetting(RULES, [ob('o1', 5), ob('o1', 6)])), 'E_PARSE');
});

test('E_PARSE: obligation date without a matching rules scope', () => {
  assert.equal(codeOf(() => runNetting(RULES, [ob('o1', 5, '2026-10-03')])), 'E_PARSE');
});

test('E_PARSE: non-integer or negative amounts rejected (no floats)', () => {
  const bad = { id: 'o1', debtor: 'M1', creditor: 'M2', ccy: 'USD', amount: 10.5, date: '2026-10-02' };
  assert.equal(codeOf(() => runNetting(RULES, [bad])), 'E_PARSE');
  assert.equal(codeOf(() => runNetting(RULES, [ob('o1', -5)])), 'E_PARSE');
});

test('E_CYCLE_DUP: duplicate canonical cycle in one solution is rejected', () => {
  assert.equal(
    codeOf(() => assertUniqueCycles([{ key: 'A→B' }, { key: 'A→B' }])),
    'E_CYCLE_DUP',
  );
  assertUniqueCycles([{ key: 'A→B' }, { key: 'B→C' }]); // distinct cycles are fine
});
