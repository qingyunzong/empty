export class LexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LexError';
  }
}

const PUNCT = new Set(['{', '}', '(', ')', '=', ';', '+', '-', '*', '/']);

// Three lexer modes:
//  - code:    identifiers, numbers, punctuation
//  - raw:     inside backticks, every character (parens, '#', ';', ...) is literal
//  - comment: from '#' to end of line (only entered from code mode)
export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }

    if (ch === '#') { // enter comment mode
      while (i < source.length && source[i] !== '\n') { i++; col++; }
      continue;
    }

    if (ch === '`') { // enter raw observation mode
      const startLine = line;
      const startCol = col;
      i++; col++;
      let text = '';
      while (i < source.length && source[i] !== '`') {
        if (source[i] === '\n') { text += '\n'; i++; line++; col = 1; }
        else { text += source[i]; i++; col++; }
      }
      if (i >= source.length) {
        throw new LexError(`unclosed raw observation (backtick) opened at ${startLine}:${startCol}`);
      }
      i++; col++; // closing backtick, back to code mode
      tokens.push({ type: 'raw', value: text, line: startLine, col: startCol });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const startCol = col;
      let num = '';
      while (i < source.length && /[0-9.]/.test(source[i])) { num += source[i]; i++; col++; }
      const value = Number(num);
      if (Number.isNaN(value)) throw new LexError(`invalid number '${num}' at ${line}:${startCol}`);
      tokens.push({ type: 'number', value, line, col: startCol });
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const startCol = col;
      let id = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) { id += source[i]; i++; col++; }
      tokens.push({ type: 'ident', value: id, line, col: startCol });
      continue;
    }

    if (PUNCT.has(ch)) {
      tokens.push({ type: ch, line, col });
      i++; col++;
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(ch)} at ${line}:${col}`);
  }

  tokens.push({ type: 'eof', line, col });
  return tokens;
}
