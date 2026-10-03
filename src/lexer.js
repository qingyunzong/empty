import { err } from './errors.js';

const KEYWORDS = new Set([
  'contract', 'currency', 'rounding', 'param', 'class', 'fee', 'let',
  'return', 'tier', 'on', 'else', 'conserve', 'allocate', 'residual',
  'and', 'or', 'not', 'money', 'bps', 'units', 'it',
  'HALF_UP', 'HALF_EVEN', 'DOWN', 'true', 'false',
]);

const TWO_CHAR = ['->', '==', '!=', '<=', '>='];
const ONE_CHAR = '{}(),:;=+-*<>';

export function lex(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  const isAlnum = (c) => isAlpha(c) || isDigit(c);

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; col = 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { col += 1; i += 1; continue; }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') { i += 1; col += 1; }
      continue;
    }
    const pos = { line, col };

    if (isDigit(c)) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j += 1;
      const intPart = src.slice(i, j);
      let fracPart = null;
      if (src[j] === '.') {
        let k = j + 1;
        while (k < src.length && isDigit(src[k])) k += 1;
        if (k === j + 1) throw err('E_LEX', `malformed number at ${line}:${col}`);
        fracPart = src.slice(j + 1, k);
        j = k;
      }
      if (src.slice(j, j + 3) === 'bps' && !isAlnum(src[j + 3] ?? '')) {
        if (fracPart !== null) {
          throw err('E_LEX', `bps literal must be an integer at ${line}:${col}`);
        }
        toks.push({ t: 'BPS', value: BigInt(intPart), raw: src.slice(i, j + 3), pos });
        col += j + 3 - i;
        i = j + 3;
        continue;
      }
      if (fracPart !== null) {
        if (fracPart.length > 2) {
          throw err('E_LEX', `money literal '${src.slice(i, j)}' exceeds 2 decimal places at ${line}:${col}`);
        }
        const cents = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, '0'));
        toks.push({ t: 'MONEY', value: cents, raw: src.slice(i, j), pos });
      } else {
        toks.push({ t: 'UNITS', value: BigInt(intPart), raw: src.slice(i, j), pos });
      }
      col += j - i;
      i = j;
      continue;
    }

    if (isAlpha(c)) {
      let j = i;
      while (j < src.length && isAlnum(src[j])) j += 1;
      const word = src.slice(i, j);
      toks.push({ t: KEYWORDS.has(word) ? 'KW' : 'IDENT', value: word, pos });
      col += j - i;
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') throw err('E_LEX', `unterminated string at ${line}:${col}`);
        if (src[j] === '\\') {
          if (j + 1 >= src.length) break;
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw err('E_LEX', `unterminated string at ${line}:${col}`);
      toks.push({ t: 'STRING', value: out, pos });
      col += j + 1 - i;
      i = j + 1;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      toks.push({ t: 'PUNCT', value: two, pos });
      i += 2;
      col += 2;
      continue;
    }
    if (ONE_CHAR.includes(c)) {
      toks.push({ t: 'PUNCT', value: c, pos });
      i += 1;
      col += 1;
      continue;
    }
    throw err('E_LEX', `unexpected character '${c}' at ${line}:${col}`);
  }
  toks.push({ t: 'EOF', pos: { line, col } });
  return toks;
}
