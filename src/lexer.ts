import type { Span } from './ast.js';

export type TokenType = 'num' | 'ident' | 'keyword' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  text: string;
  span: Span;
}

export class LexError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
    this.name = 'LexError';
  }
}

const KEYWORDS = new Set(['fn', 'true', 'false']);

const PUNCTS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '!',
  '?',
  ':',
  '(',
  ')',
  '{',
  '}',
  ',',
];

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (ch >= '0' && ch <= '9') {
      while (i < source.length && source[i] >= '0' && source[i] <= '9') i++;
      tokens.push({ type: 'num', text: source.slice(start, i), span: { start, end: i } });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      const text = source.slice(start, i);
      tokens.push({
        type: KEYWORDS.has(text) ? 'keyword' : 'ident',
        text,
        span: { start, end: i },
      });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (PUNCTS.includes(two)) {
      tokens.push({ type: 'punct', text: two, span: { start, end: i + 2 } });
      i += 2;
      continue;
    }
    if (PUNCTS.includes(ch)) {
      tokens.push({ type: 'punct', text: ch, span: { start, end: i + 1 } });
      i += 1;
      continue;
    }
    throw new LexError(`unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', text: '', span: { start: source.length, end: source.length } });
  return tokens;
}
