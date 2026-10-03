// LEB128 unsigned varint, safe for integers up to Number.MAX_SAFE_INTEGER.
export function encodeVarint(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`varint: bad value ${n}`);
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b += 128;
    bytes.push(b);
  } while (n > 0);
  return bytes;
}

export function decodeVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let i = offset;
  for (;;) {
    if (i >= buf.length) throw new Error('varint: truncated buffer');
    const b = buf[i++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 56) throw new Error('varint: overflow');
  }
  return [result, i];
}
