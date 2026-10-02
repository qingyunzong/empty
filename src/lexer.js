export class LexError extends Error {
  constructor(message, line, column) {
    super(message);
    this.name = 'LexError';
    this.line = line;
    this.column = column;
  }
}

const KEYWORDS = new Set([
  'let', 'where', 'order', 'by', 'asc', 'desc',
  'and', 'or', 'not',
  'ancestors', 'descendants', 'shortestPath', 'nodes',
  'true', 'false',
]);

const PUNCT = new Set(['(', ')', '{', '}', ',', ';']);

export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const column = () => i - lineStart + 1;
  const fail = (msg) => { throw new LexError(msg, line, column()); };
  const push = (type, value) => tokens.push({ type, value, line, column: column() });

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; lineStart = i; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i++; continue; }

    const rest = source.slice(i);

    // Lot number, e.g. LOT-2025-0001 (uppercase tag, 4-digit year, 4-digit seq)
    const lot = /^[A-Z][A-Z0-9]*-\d{4}-\d{4}(?![\w-])/.exec(rest);
    if (lot) { push('LOT', lot[0]); i += lot[0].length; continue; }

    // Date literal, e.g. 2025-01-15
    const date = /^\d{4}-\d{2}-\d{2}(?![\d-])/.exec(rest);
    if (date) { push('DATE', date[0]); i += date[0].length; continue; }

    // Number
    const num = /^\d+(\.\d+)?/.exec(rest);
    if (num) { push('NUMBER', Number(num[0])); i += num[0].length; continue; }

    // String literal
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\n') fail('unterminated string literal');
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else fail(`invalid escape sequence \\${esc}`);
          j += 2;
        } else {
          out += source[j];
          j++;
        }
      }
      if (j >= source.length) fail('unterminated string literal');
      push('STRING', out);
      i = j + 1;
      continue;
    }

    // Two-character operators
    const two = rest.slice(0, 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      push('OP', two); i += 2; continue;
    }
    if (ch === '<' || ch === '>' || ch === '=') { push('OP', ch); i++; continue; }

    if (PUNCT.has(ch)) { push('PUNCT', ch); i++; continue; }

    // Identifier / keyword
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (ident) {
      const word = ident[0];
      push(KEYWORDS.has(word) ? 'KEYWORD' : 'IDENT', word);
      i += word.length;
      continue;
    }

    fail(`unexpected character ${JSON.stringify(ch)}`);
  }

  tokens.push({ type: 'EOF', value: null, line, column: column() });
  return tokens;
}
