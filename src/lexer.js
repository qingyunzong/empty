import { DslError } from './errors.js';

const SINGLE = new Set(['{', '}', '(', ')', ':', ';', ',', '=', '.']);
const DOUBLE = new Set(['==', '!=', '->']);

export function lex(source, file = '<input>') {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '\n') {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      const startCol = col;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) {
        i += 1;
        col += 1;
      }
      tokens.push({ type: 'ident', value: source.slice(start, i), line, col: startCol });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      const startCol = col;
      while (i < source.length && /[0-9]/.test(source[i])) {
        i += 1;
        col += 1;
      }
      const digits = source.slice(start, i);
      const after = source[i + 2] ?? '';
      if (source[i] === 'm' && source[i + 1] === 's' && !/[A-Za-z0-9_]/.test(after)) {
        i += 2;
        col += 2;
        tokens.push({ type: 'ms', value: Number(digits), line, col: startCol });
      } else {
        tokens.push({ type: 'num', value: Number(digits), line, col: startCol });
      }
      continue;
    }
    const two = source.slice(i, i + 2);
    if (DOUBLE.has(two)) {
      tokens.push({ type: 'sym', value: two, line, col });
      i += 2;
      col += 2;
      continue;
    }
    if (SINGLE.has(ch)) {
      tokens.push({ type: 'sym', value: ch, line, col });
      i += 1;
      col += 1;
      continue;
    }
    throw new DslError(`unexpected character '${ch}'`, line, col, file);
  }
  tokens.push({ type: 'eof', value: '<eof>', line, col });
  return tokens;
}
