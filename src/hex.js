'use strict';

// Decode a hex dump (whitespace ignored) into bytes.
// offset in the error is the nibble index within the hex stream.
function decodeHex(text) {
  const nibbles = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
    const v = parseInt(ch, 16);
    if (Number.isNaN(v)) {
      return { error: { code: 'BAD_HEX', offset: nibbles.length } };
    }
    nibbles.push(v);
  }
  if (nibbles.length % 2 !== 0) {
    return { error: { code: 'BAD_HEX', offset: nibbles.length } };
  }
  const bytes = Buffer.alloc(nibbles.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
  }
  return { bytes };
}

module.exports = { decodeHex };
