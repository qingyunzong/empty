'use strict';

const { ParseError } = require('./frame');

// Decodes a hex text stream (whitespace tolerated) into bytes.
// Throws ParseError('BAD_HEX', charOffset) on invalid input.
function decodeHex(text) {
  const digits = [];
  let lastPos = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    const code = ch.charCodeAt(0);
    const isDigit = (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    if (!isDigit) throw new ParseError('BAD_HEX', i);
    digits.push(ch);
    lastPos = i;
  }
  if (digits.length % 2 !== 0) throw new ParseError('BAD_HEX', lastPos);
  return Buffer.from(digits.join(''), 'hex');
}

module.exports = { decodeHex };
