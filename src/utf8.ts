// UTF-8 decoding helpers operating on raw bytes. Multi-byte sequences may be
// split across arbitrary chunk boundaries; an incomplete (but so far valid)
// tail is reported as `null` so the caller can keep it pending. Invalid bytes
// decode to U+FFFD consuming a single byte.

export const REPLACEMENT_CHARACTER = 0xfffd;

export interface DecodedCodePoint {
  cp: number;
  byteLength: number;
}

/**
 * Decode one code point starting at `offset`.
 * Returns `null` when the remaining bytes form a proper prefix of a valid
 * multi-byte sequence (i.e. more bytes are needed).
 */
export function decodeOne(bytes: Uint8Array, offset: number): DecodedCodePoint | null {
  const b0 = bytes[offset];
  if (b0 < 0x80) {
    return { cp: b0, byteLength: 1 };
  }
  let len: number;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    len = 2;
  } else if (b0 >= 0xe0 && b0 <= 0xef) {
    len = 3;
  } else if (b0 >= 0xf0 && b0 <= 0xf4) {
    len = 4;
  } else {
    // Invalid lead byte (0x80-0xC1, 0xF5-0xFF).
    return { cp: REPLACEMENT_CHARACTER, byteLength: 1 };
  }
  const available = bytes.length - offset;
  const check = Math.min(len, available);
  for (let k = 1; k < check; k++) {
    const b = bytes[offset + k];
    if (b < 0x80 || b > 0xbf) {
      // A present continuation byte is invalid: this is a malformed
      // sequence, not an incomplete one.
      return { cp: REPLACEMENT_CHARACTER, byteLength: 1 };
    }
  }
  if (available < len) {
    return null;
  }
  let cp: number;
  if (len === 2) {
    cp = ((b0 & 0x1f) << 6) | (bytes[offset + 1] & 0x3f);
  } else if (len === 3) {
    cp =
      ((b0 & 0x0f) << 12) |
      ((bytes[offset + 1] & 0x3f) << 6) |
      (bytes[offset + 2] & 0x3f);
  } else {
    cp =
      ((b0 & 0x07) << 18) |
      ((bytes[offset + 1] & 0x3f) << 12) |
      ((bytes[offset + 2] & 0x3f) << 6) |
      (bytes[offset + 3] & 0x3f);
  }
  const overlong = (len === 3 && cp < 0x800) || (len === 4 && cp < 0x10000);
  const surrogate = cp >= 0xd800 && cp <= 0xdfff;
  if (overlong || surrogate || cp > 0x10ffff) {
    return { cp: REPLACEMENT_CHARACTER, byteLength: 1 };
  }
  return { cp, byteLength: len };
}

export interface DecodedStream {
  cps: number[];
  starts: number[];
  ends: number[];
}

/** Decode all complete code points; an incomplete trailing sequence is ignored. */
export function decodeAll(bytes: Uint8Array): DecodedStream {
  const cps: number[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const d = decodeOne(bytes, offset);
    if (d === null) {
      break;
    }
    cps.push(d.cp);
    starts.push(offset);
    ends.push(offset + d.byteLength);
    offset += d.byteLength;
  }
  return { cps, starts, ends };
}
