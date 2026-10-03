import { QrecError } from './errors.js';

export function uvarintEncode(n) {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new QrecError('E_VALUE', `uvarint out of range: ${n}`);
  }
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

export function uvarintDecode(buf, offset = 0) {
  let result = 0;
  let shift = 1;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new QrecError('E_FORMAT', 'truncated varint');
    const b = buf[pos++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 53) throw new QrecError('E_FORMAT', 'varint too long');
  }
  if (!Number.isSafeInteger(result)) throw new QrecError('E_FORMAT', 'varint overflow');
  return { value: result, offset: pos };
}

export function zigzagEncode(n) {
  if (!Number.isSafeInteger(n)) throw new QrecError('E_VALUE', `zigzag out of range: ${n}`);
  return n >= 0 ? 2 * n : -2 * n - 1;
}

export function zigzagDecode(z) {
  return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
}

export class ByteWriter {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.parts.push(b);
  }
  u32be(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.parts.push(b);
  }
  u64be(v) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(v));
    this.parts.push(b);
  }
  i64be(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt(v));
    this.parts.push(b);
  }
  bytes(buf) {
    this.parts.push(buf);
  }
  varint(n) {
    this.parts.push(uvarintEncode(n));
  }
  zvarint(n) {
    this.varint(zigzagEncode(n));
  }
  concat() {
    return Buffer.concat(this.parts);
  }
}
