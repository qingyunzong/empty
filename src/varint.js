// LEB128 unsigned varint + zigzag for signed values. Values must stay
// within Number.MAX_SAFE_INTEGER.

export function uvarintEncode(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`uvarint: invalid value ${n}`);
  const bytes = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

// Returns { value, offset } or null on truncation / overflow.
export function uvarintDecode(buf, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) return null;
  }
  if (!Number.isSafeInteger(result)) return null;
  return { value: result, offset: pos };
}

export function zigzagEncode(n) {
  if (!Number.isSafeInteger(n)) throw new RangeError(`zigzag: invalid value ${n}`);
  return n >= 0 ? n * 2 : -n * 2 - 1;
}

export function zigzagDecode(v) {
  return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
}
