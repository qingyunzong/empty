// Lexer for the rules DSL. Supports operation patterns (op"w*") and
// key patterns (key"x") as first-class lexical literals.

export class LexError extends Error {
  constructor(message, { file, line, col }) {
    super(message);
    this.name = 'LexError';
    this.file = file;
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set([
  'rule', 'op', 'key', 'let', 'and', 'or', 'not',
  'true', 'false', 'null',
  'happens-before', 'concurrent', 'commutes',
  'int', 'string', 'bool',
]);

export function tokenize(source, file = '<input>') {
  const tokens = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const fail = (msg) => { throw new LexError(msg, { file, line, col }); };
  const advance = () => {
    const c = source[pos++];
    if (c === '\n') { line += 1; col = 1; } else { col += 1; }
    return c;
  };
  const push = (type, value, l, c) => tokens.push({ type, value, line: l, col: c });

  function readString() {
    advance(); // opening quote
    let out = '';
    for (;;) {
      if (pos >= source.length) fail('unterminated string literal');
      const ch = advance();
      if (ch === '"') break;
      if (ch === '\n') fail('unterminated string literal');
      if (ch === '\\') {
        if (pos >= source.length) fail('unterminated string literal');
        const esc = advance();
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
      } else {
        out += ch;
      }
    }
    return out;
  }

  while (pos < source.length) {
    const c = source[pos];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }
    if (c === '#') { while (pos < source.length && source[pos] !== '\n') advance(); continue; }
    const startLine = line;
    const startCol = col;

    if (/[A-Za-z_]/.test(c)) {
      let word = '';
      while (pos < source.length && /[A-Za-z0-9_-]/.test(source[pos])) word += advance();
      // Pattern literals: op"..." and key"..." (quote directly after keyword).
      if ((word === 'op' || word === 'key') && source[pos] === '"') {
        const pat = readString();
        push(word === 'op' ? 'opPattern' : 'keyPattern', pat, startLine, startCol);
        continue;
      }
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', word, startLine, startCol);
      continue;
    }

    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(source[pos + 1] ?? ''))) {
      let num = '';
      if (c === '-') num += advance();
      while (pos < source.length && /[0-9]/.test(source[pos])) num += advance();
      push('int', parseInt(num, 10), startLine, startCol);
      continue;
    }

    if (c === '"') { push('string', readString(), startLine, startCol); continue; }

    const two = source.slice(pos, pos + 2);
    if (two === '->' || two === '==' || two === '!=' || two === '<=' || two === '>=') {
      advance(); advance();
      push('punct', two, startLine, startCol);
      continue;
    }
    if ('(){}.,:;=<>'.includes(c)) { advance(); push('punct', c, startLine, startCol); continue; }

    fail(`unexpected character ${JSON.stringify(c)}`);
  }
  push('eof', null, line, col);
  return tokens;
}
