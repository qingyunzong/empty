import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/lexer.js';

test('recognizes decimals, bps, currency and units', () => {
  const tokens = tokenize('25bps 1.00 CNY 0.5 units 150');
  assert.deepEqual(
    tokens.map((t) => [t.type, t.value]),
    [
      ['NUMBER', '25'],
      ['BPS', 'bps'],
      ['NUMBER', '1.00'],
      ['CURRENCY', 'CNY'],
      ['NUMBER', '0.5'],
      ['UNITS', 'units'],
      ['NUMBER', '150'],
      ['EOF', null],
    ]
  );
});

test('rounding keywords HALF_UP/HALF_EVEN/DOWN are keyword tokens', () => {
  const tokens = tokenize('HALF_UP HALF_EVEN DOWN');
  assert.deepEqual(tokens.slice(0, 3).map((t) => t.value), ['HALF_UP', 'HALF_EVEN', 'DOWN']);
  assert.ok(tokens.slice(0, 3).every((t) => t.type === 'KEYWORD'));
});

test('rejects malformed numbers with E_LEX', () => {
  assert.throws(() => tokenize('1.2.3'), /E_LEX/);
  assert.throws(() => tokenize('.5'), /E_LEX/);
  assert.throws(() => tokenize('12a'), /E_LEX/);
});

test('rejects unexpected characters with E_LEX', () => {
  assert.throws(() => tokenize('fee = 1 $'), /E_LEX/);
  assert.throws(() => tokenize('a @ b'), /E_LEX/);
});

test('comments and semicolons are ignored', () => {
  const tokens = tokenize('# comment\n25bps; # trailing\n');
  assert.deepEqual(tokens.map((t) => t.type), ['NUMBER', 'BPS', 'EOF']);
});
