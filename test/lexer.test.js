import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';

test('lexes statements, literals and comments', () => {
  const toks = tokenize(`
# comment
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
sell AAPL 100sh on 2024-06-20
`);
  const types = toks.map((t) => `${t.type}:${t.value}`);
  assert.ok(types.includes('ident:action'));
  assert.ok(types.includes('ident:S1'));
  assert.ok(types.includes('date:2024-06-10'));
  assert.ok(types.includes('shares:100'));
  assert.ok(types.includes('date:2024-06-20'));
  assert.equal(toks.at(-1).type, 'eof');
});

test('lexes cash literals and operators', () => {
  const toks = tokenize('cash $2.50 * (1 + 3) - $0.5');
  assert.deepEqual(
    toks.slice(0, 9).map((t) => `${t.type}:${t.value}`),
    ['ident:cash', 'cash:2.50', 'punct:*', 'punct:(', 'number:1', 'punct:+', 'number:3', 'punct:)', 'punct:-'],
  );
});

test('rejects bad characters with E_PARSE', () => {
  assert.throws(() => tokenize('ratio ~1'), (e) => e.code === 'E_PARSE');
});
