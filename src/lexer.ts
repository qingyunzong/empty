import { ParseError } from './errors';

export type TokenType = 'int' | 'str' | 'ident' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  col: number;
}

const PUNCTS = [
  '==', '!=', '<=', '>=', '&&', '||',
  '{', '}', '(', ')', '[', ']', ',', ';', ':',
  '=', '<', '>', '+', '-', '*', '/', '%', '!',
];

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const col = () => pos - lineStart + 1;

  while (pos < source.length) {
    const ch = source[pos];

    if (ch === '\n') { line++; pos++; lineStart = pos; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { pos++; continue; }

    if (ch === '/' && source[pos + 1] === '/') {
      while (pos < source.length && source[pos] !== '\n') pos++;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = pos;
      while (pos < source.length && source[pos] >= '0' && source[pos] <= '9') pos++;
      tokens.push({ type: 'int', value: source.slice(start, pos), line, col: start - lineStart + 1 });
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = pos;
      while (pos < source.length && /[A-Za-z0-9_]/.test(source[pos])) pos++;
      tokens.push({ type: 'ident', value: source.slice(start, pos), line, col: start - lineStart + 1 });
      continue;
    }

    if (ch === '"') {
      const startLine = line;
      const startCol = col();
      pos++;
      let out = '';
      while (pos < source.length && source[pos] !== '"') {
        if (source[pos] === '\n') throw new ParseError('unterminated string literal', startLine, startCol);
        if (source[pos] === '\\') {
          const esc = source[pos + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else throw new ParseError(`bad escape \\${esc}`, line, col());
          pos += 2;
        } else {
          out += source[pos];
          pos++;
        }
      }
      if (pos >= source.length) throw new ParseError('unterminated string literal', startLine, startCol);
      pos++;
      tokens.push({ type: 'str', value: out, line: startLine, col: startCol });
      continue;
    }

    const punct = PUNCTS.find((p) => source.startsWith(p, pos));
    if (punct) {
      tokens.push({ type: 'punct', value: punct, line, col: col() });
      pos += punct.length;
      continue;
    }

    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`, line, col());
  }

  tokens.push({ type: 'eof', value: '', line, col: col() });
  return tokens;
}
