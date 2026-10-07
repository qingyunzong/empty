import { ParseError } from './values.js';

export type Token =
  | { kind: 'num'; value: number; pos: number }
  | { kind: 'str'; value: string; pos: number }
  | { kind: 'ident'; name: string; pos: number }
  | { kind: 'punct'; value: string; pos: number }
  | { kind: 'eof'; pos: number };

const KEYWORDS = new Set([
  'let', 'while', 'if', 'else', 'return', 'set',
  'true', 'false', 'null', 'len',
]);

const TWO_CHAR = ['<=', '>=', '==', '!=', '&&', '||'];
const ONE_CHAR = new Set('(){}[],;:+-*/%<>=!'.split(''));

export function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const pos = i;
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j++;
      tokens.push({ kind: 'num', value: Number(src.slice(i, j)), pos });
      i = j;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= src.length) throw new ParseError(`unterminated string at ${pos}`);
        const c = src[j]!;
        if (c === '"') break;
        if (c === '\\') {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === '"' || esc === '\\') out += esc;
          else throw new ParseError(`bad escape at ${j}`);
          j += 2;
          continue;
        }
        out += c;
        j++;
      }
      tokens.push({ kind: 'str', value: out, pos });
      i = j + 1;
      continue;
    }
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      const name = src.slice(i, j);
      if (KEYWORDS.has(name)) tokens.push({ kind: 'punct', value: name, pos });
      else tokens.push({ kind: 'ident', name, pos });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      tokens.push({ kind: 'punct', value: two, pos });
      i += 2;
      continue;
    }
    if (ONE_CHAR.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, pos });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} at ${pos}`);
  }
  tokens.push({ kind: 'eof', pos: i });
  return tokens;
}
