'use strict';

// Unsigned varint (LEB128) encoding for non-negative integers.

function encodeVarint(n, out) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`varint requires a non-negative safe integer, got ${n}`);
  }
  const buf = out || [];
  let v = n;
  while (v >= 0x80) {
    buf.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  buf.push(v);
  return buf;
}

function decodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated varint');
    const byte = buf[pos];
    result += (byte & 0x7f) * 2 ** shift;
    pos += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 49) throw new Error('varint too long');
  }
  return { value: result, offset: pos };
}

// Delta-encode a sorted ascending list of non-negative integers -> Buffer.
function encodeDeltas(nums) {
  const bytes = [];
  encodeVarint(nums.length, bytes);
  let prev = 0;
  for (const n of nums) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`bad delta value ${n}`);
    encodeVarint(n - prev, bytes);
    prev = n;
  }
  return Buffer.from(bytes);
}

function decodeDeltas(buf) {
  const out = [];
  let { value: count, offset } = decodeVarint(buf, 0);
  let prev = 0;
  for (let i = 0; i < count; i += 1) {
    const r = decodeVarint(buf, offset);
    offset = r.offset;
    prev += r.value;
    out.push(prev);
  }
  return out;
}

module.exports = { encodeVarint, decodeVarint, encodeDeltas, decodeDeltas };
