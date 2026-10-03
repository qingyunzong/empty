import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/lexer.js';

test('lexes device identifiers with dashes and digits', () => {
  const toks = tokenize('devices(dev-1, sensor_a2)');
  const idents = toks.filter((t) => t.type === 'IDENT').map((t) => t.value);
  assert.deepEqual(idents, ['dev-1', 'sensor_a2']);
});

test('lexes temperature and current units', () => {
  const toks = tokenize('80C 3.5A 12');
  assert.deepEqual(
    toks.filter((t) => t.type === 'NUMBER').map((t) => [t.value, t.unit]),
    [[80, 'C'], [3.5, 'A'], [12, null]],
  );
});

test('lexes 5m-style durations to milliseconds', () => {
  const toks = tokenize('5m 30s 2h');
  const durs = toks.filter((t) => t.type === 'DURATION');
  assert.deepEqual(durs.map((t) => t.ms), [300000, 30000, 7200000]);
});

test('lexes regex device groups', () => {
  const toks = tokenize('devices(/^dev-\\d+$/)');
  const re = toks.find((t) => t.type === 'REGEX');
  assert.equal(re.value, '^dev-\\d+$');
});

test('tracks line and column', () => {
  const toks = tokenize('let a = 1\nlet b = 80C');
  const num = toks.find((t) => t.type === 'NUMBER' && t.unit === 'C');
  assert.equal(num.line, 2);
  assert.equal(num.col, 9);
});

test('rejects unknown units and unterminated regex with position', () => {
  assert.throws(() => tokenize('80F'), (e) => e instanceof LexError && e.line === 1);
  assert.throws(() => tokenize('devices(/abc'), LexError);
});
