import { DslError } from './errors.js';

const TWO_CHAR_OPS = new Set(['==', '!=', '<=', '>=']);
const SINGLE_CHAR = new Set(['{', '}', '(', ')', ':', ',', '=', '<', '>']);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const fail = (message) => {
    throw new DslError(message, line, col);
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      col = 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') { i += 1; col += 1; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { i += 1; col += 1; }
      continue;
    }
    const startCol = col;
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ type: 'op', value: two, line, col: startCol });
      i += 2;
      col += 2;
      continue;
    }
    if (SINGLE_CHAR.has(ch)) {
      const type = (ch === '=' || ch === '<' || ch === '>') ? 'op' : 'punct';
      tokens.push({ type, value: ch, line, col: startCol });
      i += 1;
      col += 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      if (source[j] === 'm' && source[j + 1] === 's') {
        tokens.push({ type: 'duration', value: Number(source.slice(i, j)), line, col: startCol });
        col += j + 2 - i;
        i = j + 2;
        continue;
      }
      fail(`invalid number '${source.slice(i, j)}': durations must end with 'ms'`);
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ type: 'ident', value: source.slice(i, j), line, col: startCol });
      col += j - i;
      i = j;
      continue;
    }
    fail(`unexpected character '${ch}'`);
  }
  tokens.push({ type: 'eof', value: '<eof>', line, col });
  return tokens;
}
