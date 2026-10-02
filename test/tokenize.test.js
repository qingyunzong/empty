import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, compileTerm } from '../src/tokenize.js';

test('CJK characters become single-char tokens with sequential positions', () => {
  assert.deepEqual(tokenize('轴承过热'), [
    { term: '轴', pos: 0 },
    { term: '承', pos: 1 },
    { term: '过', pos: 2 },
    { term: '热', pos: 3 },
  ]);
});

test('latin/digit runs are lowercased single tokens', () => {
  assert.deepEqual(tokenize('Pump2 PUMP'), [
    { term: 'pump2', pos: 0 },
    { term: 'pump', pos: 1 },
  ]);
});

test('mixed text and punctuation separators', () => {
  assert.deepEqual(tokenize('3号泵，轴承！过热').map((t) => [t.term, t.pos]), [
    ['3', 0],
    ['号', 1],
    ['泵', 2],
    ['轴', 3],
    ['承', 4],
    ['过', 5],
    ['热', 6],
  ]);
});

test('compileTerm maps a query term to its token sequence', () => {
  assert.deepEqual(compileTerm('轴承'), ['轴', '承']);
  assert.deepEqual(compileTerm('Pump2'), ['pump2']);
  assert.deepEqual(compileTerm('！！'), []);
});
