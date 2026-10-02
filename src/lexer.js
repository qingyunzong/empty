import { parseError } from './errors.js';
import { parseAmount } from './amount.js';

const KEYWORDS = new Set([
  'param', 'for', 'in', 'txns', 'when', 'revoke', 'let',
  'and', 'or', 'not', 'true', 'false',
]);

export const STATUSES = new Set([
  'SETTLED', 'PENDING', 'LOCKED', 'CANCEL_REQUESTED', 'REVERSED', 'COMPENSATED',
]);

const TWO_CHAR = new Set(['==', '!=', '<=', '>=']);
const ONE_CHAR = new Set(['{', '}', '(', ')', ';', ',', '.', '=', '+', '-', '*', '/', '<', '>']);

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) => /[A-Za-z_]/.test(c);
const isIdentPart = (c) => /[A-Za-z0-9_]/.test(c);
const isRefPart = (c) => /[A-Za-z0-9_-]/.test(c);

export function lex(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const err = (msg) => parseError(msg, { line, col });

  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { line += 1; col = 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; col += 1; continue; }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') { i += 1; col += 1; }
      continue;
    }
    const tLine = line;
    const tCol = col;

    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < source.length && source[j] !== '"' && source[j] !== '\n') { s += source[j]; j += 1; }
      if (j >= source.length || source[j] !== '"') throw err('unterminated string literal');
      tokens.push({ type: 'string', value: s, line: tLine, col: tCol });
      col += j - i + 1;
      i = j + 1;
      continue;
    }

    if (isDigit(c)) {
      let j = i;
      while (j < source.length && isDigit(source[j])) j += 1;
      let isAmount = false;
      if (source[j] === '.' && isDigit(source[j + 1])) {
        isAmount = true;
        j += 1;
        while (j < source.length && isDigit(source[j])) j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push({
        type: 'number',
        value: isAmount ? parseAmount(raw) : Number(raw),
        isAmount,
        raw,
        line: tLine,
        col: tCol,
      });
      col += j - i;
      i = j;
      continue;
    }

    if (isIdentStart(c)) {
      let j = i;
      while (j < source.length && isIdentPart(source[j])) j += 1;
      const word = source.slice(i, j);
      if ((word === 'txn' || word === 'acct') && source[j] === ':' && isRefPart(source[j + 1])) {
        let k = j + 1;
        while (k < source.length && isRefPart(source[k])) k += 1;
        tokens.push({ type: word, value: source.slice(i, k), line: tLine, col: tCol });
        col += k - i;
        i = k;
        continue;
      }
      if (KEYWORDS.has(word)) tokens.push({ type: 'keyword', value: word, line: tLine, col: tCol });
      else if (STATUSES.has(word)) tokens.push({ type: 'status', value: word, line: tLine, col: tCol });
      else tokens.push({ type: 'ident', value: word, line: tLine, col: tCol });
      col += j - i;
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      tokens.push({ type: 'punct', value: two, line: tLine, col: tCol });
      i += 2;
      col += 2;
      continue;
    }
    if (ONE_CHAR.has(c)) {
      tokens.push({ type: 'punct', value: c, line: tLine, col: tCol });
      i += 1;
      col += 1;
      continue;
    }
    throw err(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ type: 'eof', value: null, line, col });
  return tokens;
}
