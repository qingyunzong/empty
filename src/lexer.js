import { LimError } from './errors.js';

// Reserved vocabulary of the reservation DSL. `reserve`/`confirm`/`release`
// are the operation kinds shared with history events; `order` and `clock`
// declare order templates and logical clocks.
export const KEYWORDS = new Set([
  'account', 'strategy', 'capacity', 'quota', 'constraint', 'used',
  'order', 'amount', 'clock',
  'reserve', 'confirm', 'release',
]);

const PUNCT = new Set(['{', '}', '(', ')', ',']);
const OPS = ['<=', '>=', '==', '!=', '<', '>', '+', '-', '*', '='];

export function tokenize(src) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const push = (type, value) => tokens.push({ type, value, line, col });

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; col = 1; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { i++; col++; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const startLine = line;
      i += 2; col += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') { line++; col = 1; i++; } else { i++; col++; }
      }
      if (i >= src.length) throw new LimError('E_TYPE', `unterminated comment at line ${startLine}`);
      i += 2; col += 2;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      push('num', Number(src.slice(i, j)));
      col += j - i; i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word);
      col += j - i; i = j;
      continue;
    }
    if (PUNCT.has(ch)) { push('punct', ch); i++; col++; continue; }
    const two = src.slice(i, i + 2);
    if (OPS.includes(two)) { push('op', two); i += 2; col += 2; continue; }
    if (OPS.includes(ch)) { push('op', ch); i++; col++; continue; }
    throw new LimError('E_TYPE', `unexpected character '${ch}' at line ${line}:${col}`);
  }
  push('eof', null);
  return tokens;
}
