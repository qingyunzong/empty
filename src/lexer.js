// Lexer with three modes: code, raw observation (backticks), and `#` line comment.
export class LexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LexError';
  }
}

const PUNCT = new Set(['{', '}', '(', ')', '=', ';', '+', '-', '*', '/']);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let mode = 'code';
  let rawBuf = '';
  let rawLine = 0;
  let rawCol = 0;

  const advance = () => {
    const ch = source[i++];
    if (ch === '\n') {
      line += 1;
      col = 1;
    } else {
      col += 1;
    }
    return ch;
  };

  while (i < source.length) {
    if (mode === 'comment') {
      if (advance() === '\n') mode = 'code';
      continue;
    }
    if (mode === 'raw') {
      const ch = advance();
      if (ch === '`') {
        tokens.push({ type: 'raw', value: rawBuf, line: rawLine, col: rawCol });
        mode = 'code';
      } else {
        rawBuf += ch;
      }
      continue;
    }
    // code mode
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      advance();
      continue;
    }
    if (ch === '#') {
      advance();
      mode = 'comment';
      continue;
    }
    if (ch === '`') {
      advance();
      mode = 'raw';
      rawBuf = '';
      rawLine = line;
      rawCol = col - 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const startCol = col;
      let text = '';
      while (i < source.length && /[0-9.]/.test(source[i])) text += advance();
      tokens.push({ type: 'number', value: text, line, col: startCol });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const startCol = col;
      let text = '';
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) text += advance();
      tokens.push({ type: 'ident', value: text, line, col: startCol });
      continue;
    }
    if (PUNCT.has(ch)) {
      advance();
      tokens.push({ type: 'punct', value: ch, line, col: col - 1 });
      continue;
    }
    throw new LexError(`unexpected character ${JSON.stringify(ch)} at ${line}:${col}`);
  }
  if (mode === 'raw') {
    throw new LexError(`unterminated raw observation starting at ${rawLine}:${rawCol}`);
  }
  tokens.push({ type: 'eof', line, col });
  return tokens;
}
