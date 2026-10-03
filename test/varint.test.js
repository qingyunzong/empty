import { test } from "node:test";
import assert from "node:assert/strict";
import { uvarintEncode, uvarintDecode, zigzagEncode, zigzagDecode } from "../src/varint.js";
import { crc32 } from "../src/crc32.js";
import { encodeHeader, encodeRecord, decodeSegment } from "../src/segment.js";

test("uvarint round-trip across boundaries", () => {
  const values = [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 45, Number.MAX_SAFE_INTEGER];
  for (const v of values) {
    const enc = uvarintEncode(v);
    const dec = uvarintDecode(enc);
    assert.equal(dec.value, v);
    assert.equal(dec.offset, enc.length);
  }
});

test("uvarint decode reports truncation", () => {
  const enc = uvarintEncode(2 ** 45);
  assert.equal(uvarintDecode(enc.subarray(0, enc.length - 1)), null);
  assert.equal(uvarintDecode(Buffer.alloc(0)), null);
});

test("zigzag round-trip for signed deltas", () => {
  // zigzag doubles the magnitude, so stay within +-2^52 for safe-integer round-trips
  for (const v of [0, 1, -1, 2, -2, 123456, -987654, 2 ** 52, -(2 ** 52)]) {
    assert.equal(zigzagDecode(zigzagEncode(v)), v);
  }
});

test("crc32 known vector", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("segment encode/decode round-trip with delta timestamps", () => {
  const baseTs = 1_700_000_000_000;
  const recs = [
    { seq: 0, tsDelta: 0, codeId: 0 },
    { seq: 1, tsDelta: 7, codeId: 3 },
    { seq: 2, tsDelta: 250, codeId: 1 },
    { seq: 3, tsDelta: -5, codeId: 2 },
  ];
  const buf = Buffer.concat([encodeHeader(baseTs), ...recs.map(encodeRecord)]);
  const dec = decodeSegment(buf);
  assert.equal(dec.error, null);
  assert.equal(dec.validBytes, buf.length);
  assert.equal(dec.baseTs, baseTs);
  assert.deepEqual(
    dec.records,
    [
      { seq: 0, ts: baseTs, codeId: 0 },
      { seq: 1, ts: baseTs + 7, codeId: 3 },
      { seq: 2, ts: baseTs + 257, codeId: 1 },
      { seq: 3, ts: baseTs + 252, codeId: 2 },
    ],
  );
});

test("segment decoder stops at half-written record", () => {
  const good = encodeRecord({ seq: 0, tsDelta: 0, codeId: 1 });
  const tail = encodeRecord({ seq: 1, tsDelta: 3, codeId: 2 });
  const buf = Buffer.concat([encodeHeader(100), good, tail.subarray(0, tail.length - 2)]);
  const dec = decodeSegment(buf);
  assert.equal(dec.error, "truncated-payload");
  assert.equal(dec.records.length, 1);
  assert.equal(dec.validBytes, encodeHeader(100).length + good.length);
});

test("segment decoder detects bit-flip via crc", () => {
  const buf = Buffer.concat([encodeHeader(0), encodeRecord({ seq: 0, tsDelta: 1, codeId: 5 })]);
  buf[buf.length - 1] ^= 0xff;
  const dec = decodeSegment(buf);
  assert.equal(dec.error, "crc-mismatch");
  assert.equal(dec.records.length, 0);
});
