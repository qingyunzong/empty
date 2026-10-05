/** Error thrown when a URL component cannot be canonicalized. The whole
 * normalization is rejected (no partial result is produced). */
export class CanonicalizationError extends Error {
  readonly offset: number | undefined;
  constructor(message: string, offset?: number) {
    super(message);
    this.name = 'CanonicalizationError';
    this.offset = offset;
  }
}

const HEX_UPPER = '0123456789ABCDEF';

/** RFC 3986 unreserved characters: A-Z a-z 0-9 - . _ ~ */
export function isUnreservedByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x7e // ~
  );
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

export function utf8Bytes(codePoint: number): number[] {
  if (codePoint < 0x80) return [codePoint];
  if (codePoint < 0x800) return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)];
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ];
}

export function utf8EncodeString(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i) as number;
    if (cp > 0xffff) i++;
    bytes.push(...utf8Bytes(cp));
  }
  return new Uint8Array(bytes);
}

/**
 * Canonicalize one URL component (a path segment, query key or query value).
 *
 * Rules:
 *  - `%XX` escapes decoding to unreserved ASCII are decoded to the literal.
 *  - `%XX` escapes for any other byte (reserved ASCII, non-ASCII) are kept
 *    encoded, normalized to uppercase hex.
 *  - Invalid escapes (`%`, `%2`, `%GG`, ...) reject the whole normalization.
 *  - Raw non-ASCII characters are UTF-8 percent-encoded (uppercase hex).
 *  - Raw ASCII characters (including reserved ones such as `+`) pass through.
 *
 * Every equivalence-preserving rewrite is appended to `steps`.
 */
export function canonicalizeComponent(raw: string, where: string, steps: string[]): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] as string;
    if (ch === '%') {
      const h1 = i + 1 < raw.length ? hexValue(raw.charCodeAt(i + 1)) : -1;
      const h2 = i + 2 < raw.length ? hexValue(raw.charCodeAt(i + 2)) : -1;
      if (h1 < 0 || h2 < 0) {
        throw new CanonicalizationError(
          `invalid percent escape in ${where} at index ${i}: ` +
            `'${raw.slice(i, i + 3)}' — whole normalization rejected`,
          i,
        );
      }
      const byte = h1 * 16 + h2;
      if (isUnreservedByte(byte)) {
        const literal = String.fromCharCode(byte);
        out += literal;
        steps.push(`${where}: decoded %${raw[i + 1]}${raw[i + 2]} -> '${literal}' (unreserved ASCII)`);
      } else {
        const enc = '%' + HEX_UPPER[byte >> 4] + HEX_UPPER[byte & 0xf];
        out += enc;
        if (raw[i + 1] !== enc[1] || raw[i + 2] !== enc[2]) {
          steps.push(
            `${where}: kept reserved/non-ASCII byte 0x${byte.toString(16).toUpperCase().padStart(2, '0')} ` +
              `encoded, normalized to ${enc}`,
          );
        }
      }
      i += 2;
      continue;
    }
    const cp = raw.codePointAt(i) as number;
    if (cp < 0x80) {
      out += ch;
      continue;
    }
    if (cp > 0xffff) i++; // consume the low surrogate too
    const enc = utf8Bytes(cp)
      .map((b) => '%' + HEX_UPPER[b >> 4] + HEX_UPPER[b & 0x0f])
      .join('');
    out += enc;
    steps.push(`${where}: UTF-8 percent-encoded non-ASCII character '${ch}' as ${enc}`);
  }
  return out;
}
