/**
 * Canonical byte encoding.
 *
 * Format (all multi-byte numbers big-endian):
 *   0x01 <len:1> <magnitude:len>   non-negative integer, minimal-length magnitude
 *   0x02 <len:1> <magnitude:len>   negative integer n, magnitude of -1 - n
 *   0x03 <len:4> <payload>         byte string
 *   0x04 <count:4> <item>*         array
 *   0x05 <count:4> <pair>*         object; pair = key + value
 *   0x06 <len:4> <utf8>            object key (only valid inside an object)
 *
 * Object keys are UTF-8 strings sorted by raw byte order. The encoding is
 * canonical: exactly one byte representation per value.
 */

export type CanonicalValue =
  | number
  | bigint
  | Uint8Array
  | readonly CanonicalValue[]
  | ReadonlyMap<string, CanonicalValue>
  | { readonly [key: string]: CanonicalValue };

export const TAG_UINT = 0x01;
export const TAG_NEGINT = 0x02;
export const TAG_BYTES = 0x03;
export const TAG_ARRAY = 0x04;
export const TAG_OBJECT = 0x05;
export const TAG_KEY = 0x06;

const MAX_U32 = 0xffffffff;

export class EncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodeError";
  }
}

/** Encode a value to its canonical byte representation. */
export function encode(value: CanonicalValue): Buffer {
  const chunks: Buffer[] = [];
  encodeValue(value, chunks);
  return Buffer.concat(chunks);
}

/** Encode an object from explicit key/value pairs, rejecting duplicate keys. */
export function encodePairs(entries: Iterable<readonly [string, CanonicalValue]>): Buffer {
  const chunks: Buffer[] = [];
  encodeObject([...entries], chunks);
  return Buffer.concat(chunks);
}

function encodeValue(value: CanonicalValue, out: Buffer[]): void {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new EncodeError(`number is not a safe integer: ${value}`);
    }
    encodeInteger(BigInt(value), out);
  } else if (typeof value === "bigint") {
    encodeInteger(value, out);
  } else if (value instanceof Uint8Array) {
    pushTagAndLength(TAG_BYTES, value.length, out);
    out.push(Buffer.from(value));
  } else if (Array.isArray(value)) {
    pushTagAndLength(TAG_ARRAY, value.length, out);
    for (const item of value) encodeValue(item, out);
  } else if (value instanceof Map) {
    encodeObject([...value.entries()], out);
  } else if (typeof value === "object" && value !== null) {
    encodeObject(Object.entries(value), out);
  } else {
    throw new EncodeError(`unsupported value type: ${value === null ? "null" : typeof value}`);
  }
}

function encodeInteger(n: bigint, out: Buffer[]): void {
  const negative = n < 0n;
  const magnitude = minimalBytes(negative ? -1n - n : n);
  if (magnitude.length > 0xff) {
    throw new EncodeError("integer magnitude exceeds 255 bytes");
  }
  out.push(Buffer.from([negative ? TAG_NEGINT : TAG_UINT, magnitude.length]));
  out.push(magnitude);
}

function minimalBytes(m: bigint): Buffer {
  if (m === 0n) return Buffer.from([0]);
  let hex = m.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function encodeObject(entries: readonly (readonly [string, CanonicalValue])[], out: Buffer[]): void {
  const keyed = entries.map(([key, value]) => ({ bytes: utf8KeyBytes(key), key, value }));
  keyed.sort((a, b) => compareBytes(a.bytes, b.bytes));
  for (let i = 1; i < keyed.length; i++) {
    if (compareBytes(keyed[i - 1].bytes, keyed[i].bytes) === 0) {
      throw new EncodeError(`duplicate object key: ${JSON.stringify(keyed[i].key)}`);
    }
  }
  pushTagAndLength(TAG_OBJECT, keyed.length, out);
  for (const { bytes, value } of keyed) {
    pushTagAndLength(TAG_KEY, bytes.length, out);
    out.push(bytes);
    encodeValue(value, out);
  }
}

/** Validate a key and return its UTF-8 bytes. Rejects lone surrogates. */
export function utf8KeyBytes(key: string): Buffer {
  if (hasLoneSurrogate(key)) {
    throw new EncodeError(`object key contains a lone surrogate: ${JSON.stringify(key)}`);
  }
  return Buffer.from(key, "utf8");
}

export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Lexicographic comparison of raw bytes (this is the canonical key order). */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

function pushTagAndLength(tag: number, length: number, out: Buffer[]): void {
  if (length > MAX_U32) {
    throw new EncodeError(`length ${length} exceeds the 32-bit limit`);
  }
  const header = Buffer.alloc(5);
  header[0] = tag;
  header.writeUInt32BE(length, 1);
  out.push(header);
}
