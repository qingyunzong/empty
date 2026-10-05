// Shared primitives: UTF-8 code point codec and the lexical state machine.
// Everything is defined over code points (not UTF-16 units, not graphemes),
// so combining marks count as independent code points.

export const REPLACEMENT: number = 0xfffd;

export interface DecodeResult {
  cps: number[]; // decoded code points
  widths: number[]; // byte width of each decoded code point in the input
  consumed: number; // bytes consumed; the rest is an incomplete trailing sequence
}

// Decodes as many complete code points as possible. Bytes that form an
// incomplete but plausible UTF-8 prefix at the end are left unconsumed so a
// later chunk can complete them; invalid bytes decode to U+FFFD one byte at a
// time. This makes the result independent of chunk boundaries.
export function decodeCodePoints(data: Uint8Array): DecodeResult {
  const cps: number[] = [];
  const widths: number[] = [];
  let i = 0;
  while (i < data.length) {
    const b0 = data[i];
    let len: number;
    let cp: number;
    let min: number;
    if (b0 < 0x80) {
      len = 1; cp = b0; min = 0;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      len = 2; cp = b0 & 0x1f; min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      len = 3; cp = b0 & 0x0f; min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      len = 4; cp = b0 & 0x07; min = 0x10000;
    } else {
      cps.push(REPLACEMENT); widths.push(1); i += 1; continue;
    }
    if (i + len > data.length) break; // incomplete tail: wait for more bytes
    let ok = true;
    for (let k = 1; k < len; k++) {
      const b = data[i + k];
      if (b < 0x80 || b > 0xbf) { ok = false; break; }
      cp = (cp << 6) | (b & 0x3f);
    }
    if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      cps.push(REPLACEMENT); widths.push(1); i += 1; continue;
    }
    cps.push(cp); widths.push(len); i += len;
  }
  return { cps, widths, consumed: i };
}

// Minimal UTF-8 encoder (avoids any dependency on Buffer/TextEncoder types).
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

// Lexical states. A segment boundary is legal only in NORMAL: it must not sit
// inside a string literal (unclosed quote) or inside an escape sequence.
export const ST = {
  NORMAL: 0,
  SQ: 1, // inside '...'
  DQ: 2, // inside "..."
  TPL: 3, // inside `...`
  ESC_SQ: 4, // after backslash inside '...'
  ESC_DQ: 5, // after backslash inside "..."
  ESC_TPL: 6, // after backslash inside `...`
} as const;

export type LexState = (typeof ST)[keyof typeof ST];

const CP_SQUOTE = 0x27;
const CP_DQUOTE = 0x22;
const CP_BACKTICK = 0x60;
const CP_BACKSLASH = 0x5c;

export function nextState(state: LexState, cp: number): LexState {
  switch (state) {
    case ST.NORMAL:
      if (cp === CP_SQUOTE) return ST.SQ;
      if (cp === CP_DQUOTE) return ST.DQ;
      if (cp === CP_BACKTICK) return ST.TPL;
      return ST.NORMAL;
    case ST.SQ:
      if (cp === CP_BACKSLASH) return ST.ESC_SQ;
      if (cp === CP_SQUOTE) return ST.NORMAL;
      return ST.SQ;
    case ST.DQ:
      if (cp === CP_BACKSLASH) return ST.ESC_DQ;
      if (cp === CP_DQUOTE) return ST.NORMAL;
      return ST.DQ;
    case ST.TPL:
      if (cp === CP_BACKSLASH) return ST.ESC_TPL;
      if (cp === CP_BACKTICK) return ST.NORMAL;
      return ST.TPL;
    case ST.ESC_SQ:
      return ST.SQ;
    case ST.ESC_DQ:
      return ST.DQ;
    case ST.ESC_TPL:
      return ST.TPL;
  }
}
