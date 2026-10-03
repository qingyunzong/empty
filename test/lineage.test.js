import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { tokenize } from '../src/textindex.js';

// A,B raw materials -> C assembly; D housing; C+D -> E final product.
export function sample() {
  const l = new Ledger();
  l.append({ type: 'add', id: 'A', parents: [], text: 'stainless steel rod', ts: 1 });
  l.append({ type: 'add', id: 'B', parents: [], text: 'copper wire coil', ts: 2 });
  l.append({ type: 'add', id: 'C', parents: ['A', 'B'], text: 'mixed steel copper assembly', ts: 3 });
  l.append({ type: 'add', id: 'D', parents: [], text: 'plastic housing unit', ts: 4 });
  l.append({ type: 'add', id: 'E', parents: ['C', 'D'], text: 'final product steel housing', ts: 5 });
  return l;
}

test('acceptance 1: enumerate ancestors and descendants', () => {
  const l = sample();
  assert.deepEqual(l.ancestors('E').live.sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(l.ancestors('C').live.sort(), ['A', 'B']);
  assert.deepEqual(l.ancestors('A').live, []);
  assert.deepEqual(l.descendants('A').live.sort(), ['C', 'E']);
  assert.deepEqual(l.descendants('D').live, ['E']);
  assert.deepEqual(l.descendants('E').live, []);
});

test('acceptance 1: phrase and NEAR/3 index filtering cross-checked by brute force', () => {
  const l = sample();
  const s = l.stateAt();

  // phrase queries
  assert.deepEqual(l.searchPhrase('copper wire').live, ['B']);
  assert.deepEqual(l.searchPhrase('steel copper').live, ['C']);
  assert.deepEqual(l.searchPhrase('copper steel').live, []); // order matters

  // cross-check: ancestors of E filtered via index == brute-force text scan
  const anc = l.ancestors('E').live;
  const phrase = 'steel';
  const viaIndex = anc.filter((id) => l.searchPhrase(phrase).live.includes(id)).sort();
  const brute = anc
    .filter((id) => {
      const tokens = tokenize(s.batches.get(id).text);
      return tokens.includes(phrase);
    })
    .sort();
  assert.deepEqual(viaIndex, brute);
  assert.deepEqual(viaIndex, ['A', 'C']);

  // NEAR/3: 'steel' within 3 tokens of 'assembly' only in C
  assert.deepEqual(l.searchNear('steel', 'assembly', 3).live, ['C']);
  assert.deepEqual(l.searchNear('steel', 'assembly', 1).live, []); // distance 2 > 1
  assert.deepEqual(l.searchNear('steel', 'coil', 3).live, []); // never co-occur

  // NEAR cross-check against brute force over all batches
  const nearViaIndex = l.searchNear('steel', 'copper', 2).live.sort();
  const nearBrute = [...s.batches.keys()]
    .filter((id) => {
      const t = tokenize(s.batches.get(id).text);
      return t.some((x, i) => x === 'steel' && t.some((y, j) => y === 'copper' && Math.abs(i - j) <= 2));
    })
    .sort();
  assert.deepEqual(nearViaIndex, nearBrute);
});
