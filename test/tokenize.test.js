import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, sameParagraph } from '../src/tokenize.js';

test('token positions and paragraph boundaries', () => {
  const { tokens, paragraphs } = tokenize('泵 气蚀 原因码A\n\n处理码B 泵');
  assert.deepEqual(tokens, ['泵', '气蚀', '原因码a', '处理码b', '泵']);
  assert.deepEqual(paragraphs, [0, 3]);
  assert.ok(sameParagraph(paragraphs, 0, 2));
  assert.ok(!sameParagraph(paragraphs, 2, 3));
  assert.ok(!sameParagraph(paragraphs, 0, 4));
});

test('cjk runs group into one token, punctuation is dropped', () => {
  const { tokens } = tokenize('泵，气蚀。Pump-2!');
  assert.deepEqual(tokens, ['泵', '气蚀', 'pump', '2']);
});

test('punctuation-only and empty text yield no tokens', () => {
  assert.deepEqual(tokenize('！！！   ').tokens, []);
  assert.deepEqual(tokenize('').tokens, []);
});
