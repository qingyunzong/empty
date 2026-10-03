// Lexer for the rules DSL.
// Token patterns cover: device identifiers, temperature/current units
// (80C, 3.5A), durations (5m, 30s, 2h) and regex device groups (/^dev-\d+$/).

export class LexError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

const KEYWORDS = new Set([
  'let', 'alert', 'level', 'on', 'devices', 'when', 'for',
  'and', 'or', 'not',
]);

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const fail = (msg) => { throw new LexError(msg, line, col); };

  while (i < source.length) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '\n') {
      tokens.push({ type: 'NEWLINE', value: '\n', line, col });
      i++; line++; col = 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') { i++; col++; }
      continue;
    }

    const startLine = line;
    const startCol = col;

    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j])) j++;
      const word = source.slice(i, j);
      col += j - i;
      i = j;
      tokens.push({
        type: KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT',
        value: word,
        line: startLine,
        col: startCol,
      });
      continue;
    }

    if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && DIGIT.test(source[j])) j++;
      if (source[j] === '.') {
        j++;
        while (j < source.length && DIGIT.test(source[j])) j++;
      }
      const text = source.slice(i, j);
      const value = Number(text);
      const unit = source[j];
      if (unit === 'C' || unit === 'A') {
        col += j + 1 - i;
        i = j + 1;
        tokens.push({ type: 'NUMBER', value, unit, line: startLine, col: startCol });
        continue;
      }
      if (unit === 's' || unit === 'm' || unit === 'h') {
        const scale = unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
        col += j + 1 - i;
        i = j + 1;
        tokens.push({ type: 'DURATION', value, unit, ms: value * scale, line: startLine, col: startCol });
        continue;
      }
      if (unit !== undefined && /[A-Za-z]/.test(unit)) {
        throw new LexError(`unknown unit '${unit}' (expected C, A, s, m or h)`, startLine, startCol + (j - i));
      }
      col += j - i;
      i = j;
      tokens.push({ type: 'NUMBER', value, unit: null, line: startLine, col: startCol });
      continue;
    }

    if (ch === '/') {
      let j = i + 1;
      let pattern = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\\') {
          if (j + 1 >= source.length) break;
          pattern += c + source[j + 1];
          j += 2;
          continue;
        }
        if (c === '/') { closed = true; break; }
        if (c === '\n') break;
        pattern += c;
        j++;
      }
      if (!closed) throw new LexError('unterminated regex literal', startLine, startCol);
      try {
        new RegExp(pattern);
      } catch (err) {
        throw new LexError(`invalid regex: ${err.message}`, startLine, startCol);
      }
      col += j + 1 - i;
      i = j + 1;
      tokens.push({ type: 'REGEX', value: pattern, line: startLine, col: startCol });
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') {
      tokens.push({ type: 'OP', value: two, line: startLine, col: startCol });
      i += 2; col += 2;
      continue;
    }
    if (ch === '>' || ch === '<' || ch === '=') {
      tokens.push({ type: 'OP', value: ch, line: startLine, col: startCol });
      i++; col++;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: 'PUNCT', value: ch, line: startLine, col: startCol });
      i++; col++;
      continue;
    }

    fail(`unexpected character '${ch}'`);
  }

  tokens.push({ type: 'EOF', value: null, line, col });
  return tokens;
}
