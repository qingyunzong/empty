'use strict';

function encodeVarints(nums) {
  const parts = [];
  for (const n of nums) {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new RangeError(`varint requires a non-negative safe integer, got ${n}`);
    }
    let v = n;
    const bytes = [];
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b += 128;
      bytes.push(b);
    } while (v > 0);
    parts.push(Buffer.from(bytes));
  }
  return Buffer.concat(parts);
}

// Decodes up to `count` varints starting at byte `offset`.
// Returns { values, offset } where offset is the byte after the last decoded varint.
function decodeVarints(buf, count = Infinity, offset = 0) {
  const values = [];
  let i = offset;
  while (i < buf.length && values.length < count) {
    let shift = 1;
    let v = 0;
    let b;
    do {
      b = buf[i++];
      v += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    values.push(v);
  }
  return { values, offset: i };
}

function deltaEncode(sorted) {
  const deltas = [];
  let prev = 0;
  for (const n of sorted) {
    deltas.push(n - prev);
    prev = n;
  }
  return deltas;
}

function deltaDecode(deltas) {
  const out = [];
  let prev = 0;
  for (const d of deltas) {
    prev += d;
    out.push(prev);
  }
  return out;
}

module.exports = { encodeVarints, decodeVarints, deltaEncode, deltaDecode };
