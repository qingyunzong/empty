import { lexError } from './errors.js';
import { parseMoney, parseRate, dateToDays } from './money.js';

export const KEYWORDS = new Set([
  'let', 'param', 'rule', 'if', 'else',
  'and', 'or', 'not', 'true', 'false',
  'money', 'rate', 'date', 'bool',
]);

const SINGLE_CHAR = new Set(['(', ')', '{', '}', ',', ':', '=', '<', '>', '+', '-', '*', '/']);
const TWO_CHAR = new Set(['->', '==', '!=', '<=', '>=']);

const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';

// Token: { type, value, line, col, off, end }
//   money  -> value is cents (BigInt), at most 2 decimal places
//   rate   -> value is micro (BigInt), at most 6 decimal places
//   date   -> value is epoch days (number)
//   ident  -> value is the name
// keywords and punctuation use their text as `type`.
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type, value, startLine, startCol, startOff) => {
    tokens.push({ type, value, line: startLine, col: startCol, off: startOff, end: i });
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') { i++; col++; }
      continue;
    }

    const startLine = line;
    const startCol = col;
    const startOff = i;

    if (isDigit(ch)) {
      const rest = src.slice(i);
      const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(rest);
      if (dateMatch) {
        const days = dateToDays(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
        if (days === null) throw lexError(`invalid date '${dateMatch[0]}'`, startLine, startCol);
        i += dateMatch[0].length;
        col += dateMatch[0].length;
        push('date', days, startLine, startCol, startOff);
        continue;
      }
      if (/^\d{4}-/.test(rest)) throw lexError('malformed date literal', startLine, startCol);

      const numMatch = /^\d+(\.\d+)?/.exec(rest);
      let text = numMatch[0];
      let end = i + text.length;
      if (src[end] === 'e' || src[end] === 'E') {
        throw lexError('scientific notation is not allowed in literals', startLine, startCol);
      }
      const isRate = src[end] === 'r';
      if (isRate) { text += 'r'; end++; }
      const dot = text.indexOf('.');
      const fracLen = dot === -1 ? 0 : text.slice(dot + 1).replace(/r$/, '').length;
      i = end;
      col += text.length;
      if (isRate) {
        if (fracLen > 6) throw lexError('rate literal allows at most 6 decimal places', startLine, startCol);
        push('rate', parseRate(text.slice(0, -1)), startLine, startCol, startOff);
      } else {
        if (fracLen > 2) throw lexError('money literal allows at most 2 decimal places', startLine, startCol);
        push('money', parseMoney(text), startLine, startCol, startOff);
      }
      continue;
    }

    if (isAlpha(ch)) {
      const wordMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      const word = wordMatch[0];
      i += word.length;
      col += word.length;
      push(KEYWORDS.has(word) ? word : 'ident', KEYWORDS.has(word) ? undefined : word, startLine, startCol, startOff);
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      i += 2;
      col += 2;
      push(two, undefined, startLine, startCol, startOff);
      continue;
    }
    if (SINGLE_CHAR.has(ch)) {
      i += 1;
      col += 1;
      push(ch, undefined, startLine, startCol, startOff);
      continue;
    }
    throw lexError(`unexpected character '${ch}'`, startLine, startCol);
  }
  tokens.push({ type: 'eof', value: undefined, line, col, off: i, end: i });
  return tokens;
}
