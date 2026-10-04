import { isValidDate } from './schema.js';

export class LexError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Map([
  ['let', 'LET'],
  ['query', 'QUERY'],
  ['where', 'WHERE'],
  ['and', 'AND'],
  ['or', 'OR'],
  ['not', 'NOT'],
  ['true', 'TRUE'],
  ['false', 'FALSE'],
]);

const DOUBLE_OPS = new Map([
  ['==', 'EQEQ'],
  ['!=', 'NE'],
  ['<=', 'LE'],
  ['>=', 'GE'],
]);

const SINGLE_OPS = new Map([
  ['(', 'LPAREN'],
  [')', 'RPAREN'],
  [',', 'COMMA'],
  [';', 'SEMI'],
  ['=', 'EQ'],
  ['<', 'LT'],
  ['>', 'GT'],
]);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type, value, start, startLine, startCol) => {
    tokens.push({ type, value, line: startLine, col: startCol, start, end: i });
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    const start = i;
    const startLine = line;
    const startCol = col;

    const two = source.slice(i, i + 2);
    if (DOUBLE_OPS.has(two)) {
      i += 2;
      col += 2;
      push(DOUBLE_OPS.get(two), undefined, start, startLine, startCol);
      continue;
    }
    if (SINGLE_OPS.has(ch)) {
      i += 1;
      col += 1;
      push(SINGLE_OPS.get(ch), undefined, start, startLine, startCol);
      continue;
    }
    if (ch === '"') {
      i += 1;
      col += 1;
      let text = '';
      for (;;) {
        if (i >= source.length || source[i] === '\n') {
          throw new LexError('unterminated string literal', startLine, startCol);
        }
        const c = source[i];
        if (c === '"') {
          i += 1;
          col += 1;
          break;
        }
        if (c === '\\') {
          const next = source[i + 1];
          if (next === '"') text += '"';
          else if (next === '\\') text += '\\';
          else if (next === 'n') text += '\n';
          else if (next === 't') text += '\t';
          else throw new LexError(`invalid escape '\\${next ?? ''}'`, line, col);
          i += 2;
          col += 2;
          continue;
        }
        text += c;
        i += 1;
        col += 1;
      }
      push('STRING', text, start, startLine, startCol);
      continue;
    }

    const rest = source.slice(i);
    let m = rest.match(/^[A-Za-z][A-Za-z0-9]*-\d{4}-\d{4,}/);
    if (m) {
      push('LOT', m[0], start, startLine, startCol);
      i += m[0].length;
      col += m[0].length;
      continue;
    }
    m = rest.match(/^\d{4}-\d{2}-\d{2}/);
    if (m) {
      if (!isValidDate(m[0])) throw new LexError(`invalid date '${m[0]}'`, startLine, startCol);
      push('DATE', m[0], start, startLine, startCol);
      i += m[0].length;
      col += m[0].length;
      continue;
    }
    m = rest.match(/^\d+(\.\d+)?/);
    if (m) {
      push('NUMBER', Number(m[0]), start, startLine, startCol);
      i += m[0].length;
      col += m[0].length;
      continue;
    }
    m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      const kw = KEYWORDS.get(m[0]);
      push(kw ?? 'IDENT', kw ? undefined : m[0], start, startLine, startCol);
      i += m[0].length;
      col += m[0].length;
      continue;
    }
    throw new LexError(`unexpected character '${ch}'`, startLine, startCol);
  }
  tokens.push({ type: 'EOF', line, col, start: i, end: i });
  return tokens;
}
