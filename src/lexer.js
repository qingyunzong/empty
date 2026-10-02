'use strict';

const { ParseError } = require('./errors');

const KEYWORDS = new Set(['and', 'or', 'not']);
const SPECIAL_CHARS = '()"<>!=:/';

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

// Token kinds:
//   AND OR NOT LPAREN RPAREN COLON OP WORD PHRASE REGEX EOF
function tokenize(input) {
  if (typeof input !== 'string') {
    throw new ParseError('Query must be a string');
  }
  const tokens = [];
  const n = input.length;
  let i = 0;

  while (i < n) {
    const ch = input[i];

    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'LPAREN' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RPAREN' });
      i += 1;
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'COLON' });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const cj = input[j];
        if (cj === '\\' && j + 1 < n) {
          out += input[j + 1];
          j += 2;
          continue;
        }
        if (cj === quote) {
          closed = true;
          break;
        }
        out += cj;
        j += 1;
      }
      if (!closed) {
        throw new ParseError(`Unterminated quoted phrase at offset ${i}`);
      }
      tokens.push({ type: 'PHRASE', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        const cj = input[j];
        if (cj === '\\' && j + 1 < n) {
          out += cj + input[j + 1];
          j += 2;
          continue;
        }
        if (cj === '/') {
          closed = true;
          break;
        }
        if (cj === '\n') break;
        out += cj;
        j += 1;
      }
      if (!closed) {
        throw new ParseError(`Unterminated regex literal at offset ${i}`);
      }
      let flags = '';
      let k = j + 1;
      while (k < n && /[a-z]/.test(input[k])) {
        flags += input[k];
        k += 1;
      }
      tokens.push({ type: 'REGEX', value: out, flags });
      i = k;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '==') {
      tokens.push({ type: 'OP', value: two });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '=') {
      tokens.push({ type: 'OP', value: ch });
      i += 1;
      continue;
    }

    let j = i;
    while (j < n && !isSpace(input[j]) && !SPECIAL_CHARS.includes(input[j])) {
      j += 1;
    }
    if (j === i) {
      throw new ParseError(`Unexpected character '${ch}' at offset ${i}`);
    }
    const word = input.slice(i, j);
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower)) {
      tokens.push({ type: lower.toUpperCase() });
    } else {
      tokens.push({ type: 'WORD', value: word });
    }
    i = j;
  }

  tokens.push({ type: 'EOF' });
  return tokens;
}

module.exports = { tokenize };
