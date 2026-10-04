import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeUrl,
  canonicalOffsetToOriginal,
  originalOffsetToCanonical,
} from '../src/index.js';

// raw:      /a%62c/..?b=2&a=%41
// offsets:  0:/ 1:a 2:% 3:6 4:2 5:c 6:/ 7:. 8:. 9:? 10:b 11:= 12:2 13:& 14:a 15:= 16:% 17:4 18:1
// canonical: /?a=A&b=2
const RAW = '/a%62c/..?b=2&a=%41';

test('canonical string and path/query split', () => {
  const c = canonicalizeUrl(RAW);
  assert.equal(c.canonical, '/?a=A&b=2');
  assert.equal(c.canonicalPath, '/');
  assert.equal(c.canonicalQuery, 'a=A&b=2');
});

test('canonical -> original mapping (spans)', () => {
  const c = canonicalizeUrl(RAW);
  assert.deepEqual(canonicalOffsetToOriginal(c, 0), { start: 6, end: 7 }); // surviving '/'
  assert.deepEqual(canonicalOffsetToOriginal(c, 4), { start: 16, end: 19 }); // 'A' from '%41'
  assert.equal(canonicalOffsetToOriginal(c, 5), null); // synthetic '&'
  assert.equal(canonicalOffsetToOriginal(c, 99), null); // out of range
});

test('original -> canonical mapping (offsets)', () => {
  const c = canonicalizeUrl(RAW);
  assert.equal(originalOffsetToCanonical(c, 6), 0); // '/' that survived
  assert.equal(originalOffsetToCanonical(c, 0), -1); // '/' removed with dot segment
  assert.equal(originalOffsetToCanonical(c, 7), -1); // '.' removed
  assert.equal(originalOffsetToCanonical(c, 13), -1); // original '&' replaced by synthetic one
  // all three chars of '%41' map to the single canonical 'A'
  assert.equal(originalOffsetToCanonical(c, 16), 4);
  assert.equal(originalOffsetToCanonical(c, 17), 4);
  assert.equal(originalOffsetToCanonical(c, 18), 4);
});

test('mapping round-trips in both directions', () => {
  const c = canonicalizeUrl(RAW);
  for (let i = 0; i < c.canonToOrig.length; i++) {
    const span = c.canonToOrig[i];
    if (span) assert.equal(c.origToCanon[span.start], i);
  }
  for (let o = 0; o < c.origToCanon.length; o++) {
    const ci = c.origToCanon[o];
    if (ci >= 0) {
      const span = c.canonToOrig[ci];
      assert.ok(span && o >= span.start && o < span.end, `orig ${o} inside canon span ${ci}`);
    }
  }
});

test('original parameter mapping: spans slice the right text', () => {
  const c = canonicalizeUrl(RAW);
  assert.equal(c.params.length, 2);

  const a = c.params[0]; // sorted: 'a' first
  assert.equal(a.key, 'a');
  assert.equal(a.value, 'A');
  assert.equal(a.origIndex, 1);
  assert.equal(a.canonIndex, 0);
  assert.equal(RAW.slice(a.origPair.start, a.origPair.end), 'a=%41');
  assert.equal(c.canonical.slice(a.canonPair.start, a.canonPair.end), 'a=A');
  assert.ok(a.origValue && RAW.slice(a.origValue.start, a.origValue.end) === '%41');
  assert.ok(a.canonValue && c.canonical.slice(a.canonValue.start, a.canonValue.end) === 'A');

  const b = c.params[1];
  assert.equal(b.key, 'b');
  assert.equal(b.origIndex, 0);
  assert.equal(RAW.slice(b.origPair.start, b.origPair.end), 'b=2');
  assert.equal(c.canonical.slice(b.canonPair.start, b.canonPair.end), 'b=2');
});
