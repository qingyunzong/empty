// LEB128 unsigned varint + zigzag for signed deltas.

export function uvarintEncode(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`uvarint value must be a non-negative safe integer, got ${value}`);
  }
  let v = BigInt(value);
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    bytes.push(b);
  } while (v !== 0n);
  return Buffer.from(bytes);
}

export function uvarintDecode(buf, offset = 0) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new RangeError('truncated varint');
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) throw new RangeError('varint too long');
  }
  return { value: Number(result), offset: pos };
}

export function zigzagEncode(value) {
  const v = BigInt(value);
  return Number((v << 1n) ^ (v >> 63n));
}

export function zigzagDecode(u) {
  const v = BigInt(u);
  return Number((v >> 1n) ^ (-(v & 1n)));
}
