import { QError } from './errors.js';

// Unsigned LEB128 varint over safe integers.
export function uvarintEncode(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`uvarint: bad value ${n}`);
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

// Returns [value, nextOffset]. Throws E_TORN on truncation / overflow.
export function uvarintDecode(buf, off = 0) {
  let shift = 0;
  let val = 0;
  let pos = off;
  for (;;) {
    if (pos >= buf.length) throw new QError('E_TORN', 'truncated varint');
    const b = buf[pos++];
    val += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 49) throw new QError('E_TORN', 'varint too long');
  }
  return [val, pos];
}
