// Unsigned LEB128 varint over plain byte arrays.

export function pushVarint(out, n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`varint requires a non-negative safe integer, got ${n}`);
  }
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}

export function encodeVarint(n) {
  return Uint8Array.from(pushVarint([], n));
}

export function decodeVarint(bytes, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= bytes.length) throw new Error('truncated varint');
    const b = bytes[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 56) throw new Error('varint too long');
  }
  return { value: result, offset: pos };
}
