import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SearchIndex } from '../src/search.js';
import { tokenize } from '../src/tokenize.js';
import { encodePosting, decodePosting } from '../src/posting.js';
import { encodeVarint, decodeVarint } from '../src/varint.js';

test('varint roundtrip', () => {
  for (const n of [0, 1, 127, 128, 300, 65535, 2 ** 40]) {
    const buf = Uint8Array.from(encodeVarint(n));
    const [v, off] = decodeVarint(buf, 0);
    assert.equal(v, n);
    assert.equal(off, buf.length);
  }
});

test('chunked-bitset posting roundtrip across chunk boundaries', () => {
  const m = new Map([
    [0, [0, 3, 300]],
    [63, [1]],
    [64, [2, 2]],
    [65, [7]],
    [5000, [10, 20]],
  ]);
  const decoded = decodePosting(encodePosting(m));
  assert.deepEqual(decoded, m);
});

function brutePhrase(docs, terms) {
  const hits = [];
  for (const [id, text] of docs) {
    const toks = tokenize(text);
    outer: for (let i = 0; i + terms.length <= toks.length; i++) {
      for (let j = 0; j < terms.length; j++) {
        if (toks[i + j] !== terms[j]) continue outer;
      }
      hits.push(id);
      break;
    }
  }
  return hits.sort((a, b) => a - b);
}

function bruteNear(docs, terms, k) {
  const hits = [];
  for (const [id, text] of docs) {
    const toks = tokenize(text);
    let found = false;
    for (let i = 0; i < toks.length && !found; i++) {
      for (let j = i; j < Math.min(toks.length, i + k + 1) && !found; j++) {
        const window = toks.slice(i, j + 1);
        if (terms.every((t) => window.includes(t))) found = true;
      }
    }
    if (found) hits.push(id);
  }
  return hits.sort((a, b) => a - b);
}

// Acceptance 2 (text part): phrase/proximity index results match brute force.
test('phrase and near queries match brute-force text scan', () => {
  const texts = [
    '换模后延迟 2 小时，涉及冲压线',
    '换模 后 延迟已确认',
    '延迟换模，未影响交期',
    '换模后未延迟',
    'setup delay after mold change',
    '换模完成后延迟交付',
    '常规保养，无异常',
  ];
  const index = new SearchIndex();
  texts.forEach((t, i) => index.add(i + 1, t));
  const docs = texts.map((t, i) => [i + 1, t]);

  for (const phrase of ['换模 后 延迟', '换模后延迟', '延迟', 'setup delay', '保养']) {
    const terms = tokenize(phrase);
    assert.deepEqual(index.search(terms), brutePhrase(docs, terms), `phrase: ${phrase}`);
  }
  for (const k of [0, 1, 2, 4]) {
    const terms = tokenize('换模 延迟');
    assert.deepEqual(index.search(terms, { near: k }), bruteNear(docs, terms, k), `near ${k}`);
  }
  // phrase must NOT match when order is wrong
  assert.deepEqual(index.search(tokenize('延迟 换模')), brutePhrase(docs, tokenize('延迟 换模')));
});
