import { CanonicalError } from './errors.js';

/** Maximum bytes in a varint: enough for an unsigned 64-bit value. */
export const MAX_VARINT_BYTES = 10;

/** Encode a non-negative bigint as a minimal unsigned LEB128 varint. */
export function encodeVarint(value: bigint): Buffer {
  if (value < 0n) {
    throw new CanonicalError('varint cannot encode a negative value', 0);
  }
  if (value > 0xffff_ffff_ffff_ffffn) {
    throw new CanonicalError('varint value exceeds 64 bits', 0);
  }
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(Uint8Array.from(bytes));
}

export interface VarintResult {
  readonly value: bigint;
  /** Position just past the varint. */
  readonly next: number;
}

/**
 * Decode a minimal unsigned LEB128 varint from `buf` starting at `pos`.
 * Returns null when more input bytes are needed. Throws CanonicalError
 * (with a buffer-relative offset) on non-minimal or over-long encodings.
 */
export function decodeVarint(buf: Uint8Array, pos: number): VarintResult | null {
  let result = 0n;
  let shift = 0n;
  for (let i = 0; i < MAX_VARINT_BYTES; i++) {
    const index = pos + i;
    if (index >= buf.length) return null; // need more data
    const byte = buf[index]!;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      if (i > 0 && byte === 0) {
        throw new CanonicalError('non-minimal varint encoding', pos + i);
      }
      if (i === MAX_VARINT_BYTES - 1 && byte > 1) {
        throw new CanonicalError('varint exceeds 64 bits', pos);
      }
      return { value: result, next: index + 1 };
    }
    shift += 7n;
  }
  throw new CanonicalError('varint too long', pos + MAX_VARINT_BYTES - 1);
}
