/**
 * Streaming parser for the canonical byte encoding.
 *
 * Feed arbitrary chunks via push(); complete top-level values are delivered
 * to the onValue callback. All errors are reported as ParseError with an
 * absolute byte `offset` into the stream. The parser enforces canonical
 * form: minimal-length integers, strictly increasing object keys (which
 * rejects duplicates), and strictly valid UTF-8 keys (no surrogate
 * encodings, overlong forms, or out-of-range code points).
 *
 * A parser must not be reused after it has thrown.
 */

import {
  TAG_ARRAY,
  TAG_BYTES,
  TAG_KEY,
  TAG_NEGINT,
  TAG_OBJECT,
  TAG_UINT,
  compareBytes,
} from "./encode.js";

export type ParsedValue = number | bigint | Uint8Array | ParsedValue[] | Map<string, ParsedValue>;

export class ParseError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} at byte offset ${offset}`);
    this.name = "ParseError";
    this.offset = offset;
  }
}

type Frame =
  | { kind: "array"; remaining: number; items: ParsedValue[] }
  | {
      kind: "object";
      remaining: number;
      entries: Map<string, ParsedValue>;
      pendingKey: string | null;
      lastKey: Buffer | null;
    };

const MAX_SAFE = 9007199254740991n;

export class StreamParser {
  private buffer: Buffer = Buffer.from([]);
  private base = 0; // absolute stream offset of buffer[0]
  private readonly stack: Frame[] = [];
  private readonly onValue: (value: ParsedValue) => void;

  constructor(onValue: (value: ParsedValue) => void) {
    this.onValue = onValue;
  }

  /** Absolute offset of the first unconsumed byte. */
  get offset(): number {
    return this.base;
  }

  push(chunk: Uint8Array): void {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    this.drain();
  }

  /** Signal end of stream; throws if a value is incomplete. */
  end(): void {
    if (this.stack.length !== 0 || this.buffer.length !== 0) {
      throw new ParseError("unexpected end of input", this.base + this.buffer.length);
    }
  }

  private fail(message: string, rel: number): never {
    throw new ParseError(message, this.base + rel);
  }

  private drain(): void {
    let pos = 0;
    const buf = this.buffer;
    try {
      for (;;) {
        const top = this.stack[this.stack.length - 1];
        if (top !== undefined && top.kind === "object" && top.pendingKey === null) {
          const next = this.tryReadKey(buf, pos, top);
          if (next === null) break;
          pos = next;
          continue;
        }
        const result = this.tryReadValue(buf, pos);
        if (result === null) break;
        pos = result.pos;
        if (result.value === undefined) continue; // a container frame was pushed
        let value = result.value;
        for (;;) {
          const frame = this.stack[this.stack.length - 1];
          if (frame === undefined) {
            this.onValue(value);
            break;
          }
          if (frame.kind === "array") {
            frame.items.push(value);
            frame.remaining--;
            if (frame.remaining > 0) break;
            this.stack.pop();
            value = frame.items;
          } else {
            frame.entries.set(frame.pendingKey as string, value);
            frame.pendingKey = null;
            frame.remaining--;
            if (frame.remaining > 0) break;
            this.stack.pop();
            value = frame.entries;
          }
        }
      }
    } finally {
      if (pos > 0) {
        this.buffer = buf.subarray(pos);
        this.base += pos;
      }
    }
  }

  /** Returns the new position, or null if more bytes are needed. */
  private tryReadValue(
    buf: Buffer,
    pos: number,
  ): { pos: number; value?: ParsedValue } | null {
    if (pos >= buf.length) return null;
    const tag = buf[pos];
    switch (tag) {
      case TAG_UINT:
      case TAG_NEGINT: {
        if (pos + 2 > buf.length) return null;
        const len = buf[pos + 1];
        if (len === 0) this.fail("integer with zero-length magnitude", pos + 1);
        if (pos + 2 + len > buf.length) return null;
        if (len > 1 && buf[pos + 2] === 0) this.fail("non-minimal integer encoding", pos + 2);
        let magnitude = 0n;
        for (let i = 0; i < len; i++) magnitude = (magnitude << 8n) | BigInt(buf[pos + 2 + i]);
        const n = tag === TAG_NEGINT ? -1n - magnitude : magnitude;
        return { pos: pos + 2 + len, value: toSafe(n) };
      }
      case TAG_BYTES: {
        if (pos + 5 > buf.length) return null;
        const len = buf.readUInt32BE(pos + 1);
        if (pos + 5 + len > buf.length) return null;
        return { pos: pos + 5 + len, value: Uint8Array.from(buf.subarray(pos + 5, pos + 5 + len)) };
      }
      case TAG_ARRAY: {
        if (pos + 5 > buf.length) return null;
        const count = buf.readUInt32BE(pos + 1);
        if (count === 0) return { pos: pos + 5, value: [] };
        this.stack.push({ kind: "array", remaining: count, items: [] });
        return { pos: pos + 5 };
      }
      case TAG_OBJECT: {
        if (pos + 5 > buf.length) return null;
        const count = buf.readUInt32BE(pos + 1);
        if (count === 0) return { pos: pos + 5, value: new Map() };
        this.stack.push({ kind: "object", remaining: count, entries: new Map(), pendingKey: null, lastKey: null });
        return { pos: pos + 5 };
      }
      case TAG_KEY:
        this.fail("string tag is only valid as an object key", pos);
        break;
      default:
        this.fail(`unknown tag 0x${tag.toString(16).padStart(2, "0")}`, pos);
    }
  }

  /** Returns the new position, or null if more bytes are needed. */
  private tryReadKey(
    buf: Buffer,
    pos: number,
    frame: Extract<Frame, { kind: "object" }>,
  ): number | null {
    if (pos >= buf.length) return null;
    if (buf[pos] !== TAG_KEY) {
      this.fail(`expected object key (tag 0x06), found tag 0x${buf[pos].toString(16).padStart(2, "0")}`, pos);
    }
    if (pos + 5 > buf.length) return null;
    const len = buf.readUInt32BE(pos + 1);
    if (pos + 5 + len > buf.length) return null;
    const bytes = buf.subarray(pos + 5, pos + 5 + len);
    const bad = utf8ErrorIndex(bytes);
    if (bad !== -1) this.fail("object key is not valid UTF-8", pos + 5 + bad);
    if (frame.lastKey !== null) {
      const order = compareBytes(frame.lastKey, bytes);
      if (order === 0) this.fail("duplicate object key", pos);
      if (order > 0) this.fail("object keys are not in canonical order", pos);
    }
    frame.pendingKey = bytes.toString("utf8");
    frame.lastKey = Buffer.from(bytes);
    return pos + 5 + len;
  }
}

function toSafe(n: bigint): number | bigint {
  return n >= -MAX_SAFE && n <= MAX_SAFE ? Number(n) : n;
}

/**
 * Strict UTF-8 validation. Returns the index of the first byte that starts
 * an invalid sequence, or -1 if the input is valid. Rejects overlong forms,
 * surrogate code points, and values above U+10FFFF.
 */
export function utf8ErrorIndex(bytes: Uint8Array): number {
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    if (b0 < 0x80) {
      i++;
      continue;
    }
    let need: number;
    let min2 = 0x80;
    let max2 = 0xbf;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
    } else if (b0 === 0xe0) {
      need = 2;
      min2 = 0xa0;
    } else if (b0 >= 0xe1 && b0 <= 0xec) {
      need = 2;
    } else if (b0 === 0xed) {
      need = 2;
      max2 = 0x9f; // exclude U+D800..U+DFFF surrogates
    } else if (b0 >= 0xee && b0 <= 0xef) {
      need = 2;
    } else if (b0 === 0xf0) {
      need = 3;
      min2 = 0x90;
    } else if (b0 >= 0xf1 && b0 <= 0xf3) {
      need = 3;
    } else if (b0 === 0xf4) {
      need = 3;
      max2 = 0x8f; // cap at U+10FFFF
    } else {
      return i;
    }
    if (i + need >= bytes.length) return i;
    const b1 = bytes[i + 1];
    if (b1 < min2 || b1 > max2) return i;
    for (let j = 2; j <= need; j++) {
      const cont = bytes[i + j];
      if (cont < 0x80 || cont > 0xbf) return i;
    }
    i += need + 1;
  }
  return -1;
}
