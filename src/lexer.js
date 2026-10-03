// Lexer: numbers with units (g, kg, ppm, CNY, ¥), identifiers, comments.
// Every token carries line/col so diagnostics can point at source.

export class Diagnostic extends Error {
  constructor(message, line, col, file) {
    super(message);
    this.name = 'Diagnostic';
    this.line = line;
    this.col = col;
    this.file = file;
  }
  format() {
    return `${this.file ?? '<input>'}:${this.line}:${this.col}: error: ${this.message}`;
  }
}

export const UNITS = new Set(['g', 'kg', 'ppm', 'CNY', '¥']);

const PUNCT = '{}()[],:;=+-*/<>';
const TWO_CHAR = new Set(['<=', '>=', '==']);

export function lex(src, file = '<input>') {
  const toks = [];
  let i = 0;
  let line = 1;
  let col = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      i++;
      line++;
      col = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      col++;
      continue;
    }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') {
        i++;
        col++;
      }
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const startCol = col;
      let j = i;
      while (j < src.length && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') {
        j++;
        while (j < src.length && /[0-9]/.test(src[j])) j++;
      }
      toks.push({ t: 'num', v: parseFloat(src.slice(i, j)), line, col: startCol });
      col += j - i;
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const startCol = col;
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      toks.push({ t: UNITS.has(word) ? 'unit' : 'ident', v: word, line, col: startCol });
      col += j - i;
      i = j;
      continue;
    }
    if (ch === '¥') {
      toks.push({ t: 'unit', v: '¥', line, col });
      i++;
      col++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.has(two)) {
      toks.push({ t: 'punct', v: two, line, col });
      i += 2;
      col += 2;
      continue;
    }
    if (PUNCT.includes(ch)) {
      toks.push({ t: 'punct', v: ch, line, col });
      i++;
      col++;
      continue;
    }
    throw new Diagnostic(`unexpected character ${JSON.stringify(ch)}`, line, col, file);
  }
  toks.push({ t: 'eof', v: '', line, col });
  return toks;
}
