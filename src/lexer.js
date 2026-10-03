// Lexer for the recipe DSL. Supports g / kg / ppm / CNY units (as identifiers,
// resolved by the parser), // line comments, /* */ block comments, strings,
// decimal numbers and comparison / arithmetic operators.

export class Diagnostic extends Error {
  constructor(message, line, col, file) {
    super(message);
    this.name = 'Diagnostic';
    this.line = line;
    this.col = col;
    this.file = file;
  }
  toString() {
    const where = this.file ? `${this.file}:` : '';
    return `${where}${this.line}:${this.col}: error: ${this.message}`;
  }
}

const OPS = ['<=', '>=', '==', '<', '>', '=', '+', '-', '*', '/', '(', ')', '{', '}', ';', '.', ',', ':'];

export function tokenize(source, file = '<input>') {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const n = source.length;

  const push = (type, value, tLine, tCol) => tokens.push({ type, value, line: tLine, col: tCol });

  while (i < n) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') { i++; col++; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      i += 2; col += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') { i += 2; col += 2; closed = true; break; }
        if (source[i] === '\n') { i++; line++; col = 1; } else { i++; col++; }
      }
      if (!closed) throw new Diagnostic('unterminated block comment', startLine, startCol, file);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let text = '';
      while (i < n && /[0-9]/.test(source[i])) { text += source[i++]; col++; }
      if (source[i] === '.' && /[0-9]/.test(source[i + 1] || '')) {
        text += source[i++]; col++;
        while (i < n && /[0-9]/.test(source[i])) { text += source[i++]; col++; }
      }
      push('num', text, startLine, startCol);
      continue;
    }
    if (/[A-Za-z_一-鿿]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let text = '';
      while (i < n && /[A-Za-z0-9_一-鿿]/.test(source[i])) { text += source[i++]; col++; }
      push('ident', text, startLine, startCol);
      continue;
    }
    if (ch === '"') {
      const startLine = line;
      const startCol = col;
      i++; col++;
      let text = '';
      let closed = false;
      while (i < n) {
        if (source[i] === '"') { i++; col++; closed = true; break; }
        if (source[i] === '\n') throw new Diagnostic('unterminated string literal', startLine, startCol, file);
        if (source[i] === '\\' && source[i + 1] === '"') { text += '"'; i += 2; col += 2; continue; }
        text += source[i++]; col++;
      }
      if (!closed) throw new Diagnostic('unterminated string literal', startLine, startCol, file);
      push('string', text, startLine, startCol);
      continue;
    }
    const two = source.slice(i, i + 2);
    if (OPS.includes(two)) { push('punct', two, line, col); i += 2; col += 2; continue; }
    if (OPS.includes(ch)) { push('punct', ch, line, col); i++; col++; continue; }
    throw new Diagnostic(`unexpected character ${JSON.stringify(ch)}`, line, col, file);
  }
  push('eof', '', line, col);
  return tokens;
}
