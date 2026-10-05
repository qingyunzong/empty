import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { CanonicalParser, parseCanonical } from '../src/parser.js';
import { CanonicalError } from '../src/errors.js';
import { encodeCanonical } from '../src/encoder.js';
import type { CanonicalValue } from '../src/types.js';

function bytes(hexString: string): Buffer {
  return Buffer.from(Uint8Array.from(hexString.match(/../g)!.map((h) => parseInt(h, 16))));
}

test('round-trips values of every type', () => {
  const value: CanonicalValue = {
    name: Uint8Array.of(109, 97, 110, 105, 102, 101, 115, 116),
    version: 3,
    blob: Uint8Array.of(0, 1, 255),
    deps: ['a', 'b'].map((d) => new Map<string, CanonicalValue>([[d, [1, -2, 3n]]]) as CanonicalValue),
    empty: [],
    unicode: { 'é': 1, '😀': -1 },
  };
  const parsed = parseCanonical(encodeCanonical(value));
  // re-encoding the parsed value must reproduce the identical canonical bytes
  assert.equal(
    Buffer.from(encodeCanonical(parsed as CanonicalValue)).toString('hex'),
    Buffer.from(encodeCanonical(value)).toString('hex'),
  );
});

test('streaming: one byte at a time yields the value only when complete', () => {
  const data = encodeCanonical({ key: [1, 2, 3], raw: Uint8Array.of(7, 8) });
  const parser = new CanonicalParser();
  let result = null;
  for (let i = 0; i < data.length; i++) {
    parser.write(data.subarray(i, i + 1));
    result = parser.tryParse();
    if (i < data.length - 1) {
      assert.equal(result, null, `should be incomplete after byte ${i}`);
    }
  }
  assert.ok(result !== null);
  assert.equal(result.bytesConsumed, data.length);
  assert.equal(parser.consumed, data.length);
  assert.equal(parser.pending, 0);
});

test('streaming: multiple values in one stream parse sequentially', () => {
  const a = encodeCanonical(1);
  const b = encodeCanonical('x'.charCodeAt(0));
  const c = encodeCanonical([Uint8Array.of(9)]);
  const parser = new CanonicalParser();
  parser.write(Buffer.concat([a, b, c]));
  const first = parser.tryParse();
  const second = parser.tryParse();
  const third = parser.tryParse();
  assert.ok(first && second && third);
  assert.equal(first.value, 1);
  assert.equal(second.value, 120);
  assert.equal(parser.consumed, a.length + b.length + c.length);
  assert.equal(parser.tryParse(), null);
});

test('error offset: duplicate key reports the offset of the second key', () => {
  // 6f 02 | 01 61 6900 | 01 61 6900  -> second entry starts at offset 6
  const data = bytes('6f020161 6900 0161 6900'.replace(/ /g, ''));
  assert.throws(
    () => parseCanonical(data),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalError);
      assert.equal(err.offset, 6);
      assert.match(err.message, /duplicate object key/);
      return true;
    },
  );
});

test('error offset: out-of-order keys are rejected at the misplaced key', () => {
  // keys 'b' then 'a': second entry starts at offset 6
  const data = bytes('6f02016269000161 6900'.replace(/ /g, ''));
  assert.throws(
    () => parseCanonical(data),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalError);
      assert.equal(err.offset, 6);
      assert.match(err.message, /out of canonical order/);
      return true;
    },
  );
});

test('error offset: invalid UTF-8 in a key points at the key bytes', () => {
  // 6f 01 01 ff 6900 -> key length 1 at offset 2, key byte 0xff at offset 3
  const data = bytes('6f0101ff6900');
  assert.throws(
    () => parseCanonical(data),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalError);
      assert.equal(err.offset, 3);
      assert.match(err.message, /not valid UTF-8/);
      return true;
    },
  );
});

test('error offset: non-minimal varint points at the redundant byte', () => {
  // 69 80 00 -> integer tag at 0, varint 0x80 0x00 is non-minimal at offset 2
  const data = bytes('698000');
  assert.throws(
    () => parseCanonical(data),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalError);
      assert.equal(err.offset, 2);
      assert.match(err.message, /non-minimal varint/);
      return true;
    },
  );
});

test('error offset: unknown tag points at the tag byte', () => {
  assert.throws(
    () => parseCanonical(bytes('ff00')),
    (err: unknown) => err instanceof CanonicalError && err.offset === 0 && /unknown type tag/.test(err.message),
  );
});

test('error offset: truncated input after end() points past the last byte', () => {
  const parser = new CanonicalParser();
  parser.write(bytes('62050102')); // byte string promising 5 bytes, only 2 given
  parser.end();
  assert.throws(
    () => parser.tryParse(),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalError);
      assert.equal(err.offset, 4);
      assert.match(err.message, /truncated/);
      return true;
    },
  );
});

test('error offsets stay absolute across chunk boundaries', () => {
  // stream: valid value (2 bytes) then an object with a duplicate key;
  // the duplicate starts at absolute offset 2 + 6 = 8
  const good = encodeCanonical(0); // 2 bytes
  const bad = bytes('6f020161690 00161 6900'.replace(/ /g, ''));
  const parser = new CanonicalParser();
  parser.write(good);
  const first = parser.tryParse();
  assert.ok(first);
  assert.equal(parser.consumed, 2);
  // feed the bad object in two chunks so the error lands mid-stream
  parser.write(bad.subarray(0, 4));
  assert.equal(parser.tryParse(), null);
  parser.write(bad.subarray(4));
  assert.throws(
    () => parser.tryParse(),
    (err: unknown) => {
      assert.ok(err instanceof CanonicalError);
      assert.equal(err.offset, 8);
      assert.match(err.message, /duplicate object key/);
      return true;
    },
  );
});

test('trailing bytes after a complete value are rejected', () => {
  assert.throws(
    () => parseCanonical(bytes('69006900')),
    (err: unknown) => err instanceof CanonicalError && err.offset === 2 && /trailing bytes/.test(err.message),
  );
});

test('surrogate halves encoded as (invalid) UTF-8 are rejected', () => {
  // CESU-8 style encoding of U+D800: ed a0 80 -- invalid in strict UTF-8
  const data = bytes('6f0103' + 'eda080' + '6900');
  assert.throws(
    () => parseCanonical(data),
    (err: unknown) => err instanceof CanonicalError && err.offset === 3,
  );
});
