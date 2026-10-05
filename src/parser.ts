import { CanonicalError } from './errors.js';
import { TAG_ARRAY, TAG_BYTES, TAG_INTEGER, TAG_OBJECT } from './tags.js';
import type { CanonicalValue } from './types.js';
import { decodeVarint } from './varint.js';

/** Sentinel thrown internally when the buffer runs out mid-value. */
class NeedMoreData extends Error {}

/** Parsed object form: a Map preserves sorted key order and any key string. */
export type ParsedValue = number | bigint | Uint8Array | ParsedValue[] | Map<string, ParsedValue>;

interface DecodeResult {
  readonly value: ParsedValue;
  readonly next: number;
}

function need(result: DecodeResult | null): DecodeResult {
  if (result === null) throw new NeedMoreData();
  return result;
}

function readVarint(buf: Uint8Array, pos: number): { value: bigint; next: number } {
  const r = decodeVarint(buf, pos);
  if (r === null) throw new NeedMoreData();
  return r;
}

function readBytes(buf: Uint8Array, pos: number, length: number): Uint8Array {
  if (pos + length > buf.length) throw new NeedMoreData();
  return buf.subarray(pos, pos + length);
}

function unzigzag(z: bigint): bigint {
  return z % 2n === 0n ? z / 2n : -(z + 1n) / 2n;
}

const fatalUtf8 = () => new TextDecoder('utf-8', { fatal: true });

function decodeKey(buf: Uint8Array, pos: number): { key: string; keyRaw: Uint8Array; next: number } {
  const len = readVarint(buf, pos);
  const keyRaw = readBytes(buf, len.next, Number(len.value));
  const next = len.next + Number(len.value);
  let key: string;
  try {
    key = fatalUtf8().decode(keyRaw);
  } catch {
    throw new CanonicalError('object key is not valid UTF-8', len.next);
  }
  if (!key.isWellFormed()) {
    throw new CanonicalError(`object key contains an unpaired surrogate: ${JSON.stringify(key)}`, len.next);
  }
  return { key, keyRaw, next };
}

function decodeValue(buf: Uint8Array, pos: number): DecodeResult {
  if (pos >= buf.length) throw new NeedMoreData();
  const tag = buf[pos]!;

  switch (tag) {
    case TAG_INTEGER: {
      const z = readVarint(buf, pos + 1);
      const n = unzigzag(z.value);
      const value = n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(-Number.MAX_SAFE_INTEGER)
        ? Number(n)
        : n;
      return { value, next: z.next };
    }
    case TAG_BYTES: {
      const len = readVarint(buf, pos + 1);
      const data = readBytes(buf, len.next, Number(len.value));
      return { value: data.slice(), next: len.next + Number(len.value) };
    }
    case TAG_ARRAY: {
      const count = readVarint(buf, pos + 1);
      let cursor = count.next;
      const items: ParsedValue[] = [];
      for (let i = 0n; i < count.value; i++) {
        const r = decodeValue(buf, cursor);
        items.push(r.value);
        cursor = r.next;
      }
      return { value: items, next: cursor };
    }
    case TAG_OBJECT: {
      const count = readVarint(buf, pos + 1);
      let cursor = count.next;
      const map = new Map<string, ParsedValue>();
      let prevKeyRaw: Uint8Array | null = null;
      for (let i = 0n; i < count.value; i++) {
        const entryOffset = cursor;
        const { key, keyRaw, next } = decodeKey(buf, cursor);
        if (prevKeyRaw !== null) {
          const cmp = Buffer.from(prevKeyRaw).compare(Buffer.from(keyRaw));
          if (cmp === 0) {
            throw new CanonicalError(`duplicate object key: ${JSON.stringify(key)}`, entryOffset);
          }
          if (cmp > 0) {
            throw new CanonicalError(`object keys out of canonical order at key: ${JSON.stringify(key)}`, entryOffset);
          }
        }
        prevKeyRaw = keyRaw;
        const v = decodeValue(buf, next);
        map.set(key, v.value);
        cursor = v.next;
      }
      return { value: map, next: cursor };
    }
    default:
      throw new CanonicalError(`unknown type tag 0x${tag.toString(16).padStart(2, '0')}`, pos);
  }
}

/**
 * Incremental parser for canonical byte streams. Feed chunks with write(),
 * then call tryParse() to extract complete values. All errors are reported
 * as CanonicalError with an absolute stream offset, no matter how the input
 * was chunked.
 */
export class CanonicalParser {
  private buffer: Uint8Array = Buffer.alloc(0);
  private baseOffset = 0;
  private ended = false;

  /** Number of bytes consumed by successfully parsed values so far. */
  get consumed(): number {
    return this.baseOffset;
  }

  /** Number of buffered bytes not yet consumed by a parsed value. */
  get pending(): number {
    return this.buffer.length;
  }

  write(chunk: Uint8Array): void {
    if (this.ended) throw new CanonicalError('write after end', this.baseOffset + this.buffer.length);
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
  }

  /** Signal end of input; a trailing partial value then becomes an error. */
  end(): void {
    this.ended = true;
  }

  /**
   * Try to parse one complete value from the buffered input.
   * Returns null when more bytes are needed. Throws CanonicalError with an
   * absolute offset when the input is invalid (or truncated after end()).
   */
  tryParse(): { value: ParsedValue; bytesConsumed: number } | null {
    if (this.buffer.length === 0) return null;
    try {
      const r = decodeValue(this.buffer, 0);
      this.buffer = this.buffer.subarray(r.next);
      this.baseOffset += r.next;
      return { value: r.value, bytesConsumed: r.next };
    } catch (err) {
      if (err instanceof NeedMoreData) {
        if (this.ended) {
          throw new CanonicalError('truncated input at end of stream', this.baseOffset + this.buffer.length);
        }
        return null;
      }
      if (err instanceof CanonicalError) {
        throw new CanonicalError(stripOffset(err.message), this.baseOffset + err.offset);
      }
      throw err;
    }
  }
}

function stripOffset(message: string): string {
  return message.replace(/ \(at byte offset \d+\)$/, '');
}

/** Parse exactly one value from a complete buffer. */
export function parseCanonical(data: Uint8Array): ParsedValue {
  const parser = new CanonicalParser();
  parser.write(data);
  parser.end();
  const r = parser.tryParse();
  if (r === null) throw new CanonicalError('empty input', 0);
  if (parser.pending > 0) {
    throw new CanonicalError('trailing bytes after complete value', r.bytesConsumed);
  }
  return r.value;
}
