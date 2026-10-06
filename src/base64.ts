const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Encode(text: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const codePoint = text.codePointAt(i)!;
    if (codePoint > 0xffff) i++;
    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function utf8Decode(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i]!;
    let codePoint: number;
    let length: number;
    if (b0 < 0x80) {
      codePoint = b0;
      length = 1;
    } else if (b0 < 0xe0) {
      codePoint = b0 & 0x1f;
      length = 2;
    } else if (b0 < 0xf0) {
      codePoint = b0 & 0x0f;
      length = 3;
    } else {
      codePoint = b0 & 0x07;
      length = 4;
    }
    for (let j = 1; j < length; j++) {
      const bx = bytes[i + j];
      if (bx === undefined || (bx & 0xc0) !== 0x80) {
        throw new Error("invalid UTF-8 sequence");
      }
      codePoint = (codePoint << 6) | (bx & 0x3f);
    }
    out += String.fromCodePoint(codePoint);
    i += length;
  }
  return out;
}

export function encodeBase64Url(text: string): string {
  const bytes = utf8Encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 !== undefined) out += ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 !== undefined) out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function decodeBase64Url(encoded: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of encoded) {
    const value = ALPHABET.indexOf(ch);
    if (value === -1) {
      throw new Error(`invalid base64url character: ${JSON.stringify(ch)}`);
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return utf8Decode(bytes);
}
