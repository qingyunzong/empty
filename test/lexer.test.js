import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, LexError } from '../src/lexer.js';

test('词法：单位 kW / kWh / min 与数字', () => {
  const toks = tokenize('power 10 kW energy 1.5 kWh duration 30 min');
  const units = toks.filter((t) => t.type === 'unit').map((t) => t.value);
  assert.deepEqual(units, ['kW', 'kWh', 'min']);
  const nums = toks.filter((t) => t.type === 'num').map((t) => t.value);
  assert.deepEqual(nums, [10, 1.5, 30]);
});

test('词法：注释被跳过', () => {
  const toks = tokenize('# 整行注释\npower 5 kW # 行尾注释\n');
  assert.deepEqual(toks.map((t) => String(t.value)), ['power', '5', 'kW', '<eof>']);
});

test('词法：时刻 token', () => {
  const toks = tokenize('08:00-20:00');
  assert.deepEqual(toks.map((t) => t.type), ['time', 'punct', 'time', 'eof']);
});

test('词法：非法时刻报错并带行列', () => {
  assert.throws(
    () => tokenize('x\n  08:70'),
    (e) => e instanceof LexError && e.line === 2 && e.col === 3,
  );
});

test('词法：非法字符报错并带行列', () => {
  assert.throws(
    () => tokenize('a\n\n @'),
    (e) => e instanceof LexError && e.line === 3 && e.col === 2,
  );
});

test('词法：电价为普通数字', () => {
  const toks = tokenize('price 00:00-06:00 0.30');
  assert.equal(toks[4].type, 'num');
  assert.equal(toks[4].value, 0.3);
});
