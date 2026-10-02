import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/index.js';

test('raw observation keeps literal characters like parens and hashes', () => {
  const tokens = tokenize('let obs = `raw (1+2) # not-comment { }`;');
  const raw = tokens.find((t) => t.type === 'raw');
  assert.equal(raw.value, 'raw (1+2) # not-comment { }');
});

test('line comments are skipped in code mode', () => {
  const tokens = tokenize('let a = 1; # comment with `backtick`\nlet b = 2;');
  const idents = tokens.filter((t) => t.type === 'ident').map((t) => t.value);
  assert.deepEqual(idents, ['let', 'a', 'let', 'b']);
});

test('unterminated raw observation is a lex error', () => {
  assert.throws(() => tokenize('let a = `oops;'), (err) => {
    assert.ok(err instanceof LexError);
    assert.match(err.message, /unterminated raw observation/);
    return true;
  });
});
