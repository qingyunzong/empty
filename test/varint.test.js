import test from 'node:test';
import assert from 'node:assert/strict';

const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code);
import { uvarintEncode, uvarintDecode } from '../src/varint.js';

test('uvarint roundtrip', () => {
  for (const n of [0, 1, 2, 127, 128, 129, 300, 16384, 2 ** 20, 2 ** 32, 2 ** 52]) {
    const buf = uvarintEncode(n);
    const [v, off] = uvarintDecode(buf);
    assert.equal(v, n);
    assert.equal(off, buf.length);
  }
});

test('uvarint canonical sizes', () => {
  assert.equal(uvarintEncode(0).length, 1);
  assert.equal(uvarintEncode(127).length, 1);
  assert.equal(uvarintEncode(128).length, 2);
  assert.equal(uvarintEncode(300)[0], 0xac);
  assert.equal(uvarintEncode(300)[1], 0x02);
});

test('uvarint truncated -> E_TORN', () => {
  throwsCode(() => uvarintDecode(Buffer.from([0x80])), 'E_TORN');
});
