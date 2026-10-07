import type { Span } from './ast.ts';
import { ParseError } from './errors.ts';

export interface Token {
  type: 'num' | 'ident' | 'op' | 'eof';
  value: string;
  span: Span;
}

const TWO_CHAR_OPS = ['==', '!=', '<=', '>=', '&&', '||', '=>'];
const ONE_CHAR_OPS = ['+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', ',', '=', ';'];

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      tokens.push({ type: 'num', value: source.slice(start, i), span: { start, end: i } });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      tokens.push({ type: 'ident', value: source.slice(start, i), span: { start, end: i } });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two, span: { start: i, end: i + 2 } });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch, span: { start: i, end: i + 1 } });
      i++;
      continue;
    }
    throw new ParseError(`Unexpected character '${ch}'`, { start: i, end: i + 1 }, source);
  }
  tokens.push({ type: 'eof', value: '', span: { start: i, end: i } });
  return tokens;
}
