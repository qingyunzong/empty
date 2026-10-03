import { RevError, E } from './errors.js';

const KEYWORDS = new Set([
  'param', 'let', 'for', 'in', 'if', 'else',
  'reverse', 'cancel', 'move', 'from', 'to',
  'and', 'or', 'not', 'true', 'false',
]);

export const STATUS_WORDS = new Set([
  'SETTLED', 'PENDING', 'CANCEL_REQUESTED', 'REVERSED', 'FAILED', 'LOCKED',
]);

export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const error = (msg) => {
    throw new RevError(E.PARSE, `${msg} (line ${line}, col ${col})`);
  };
  const peek = (k = 0) => src[i + k];
  const advance = () => {
    const c = src[i++];
    if (c === '\n') { line++; col = 1; } else col++;
    return c;
  };

  while (i < src.length) {
    const c = peek();
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }
    if (c === '#') { while (i < src.length && peek() !== '\n') advance(); continue; }
    if (c === '/' && peek(1) === '/') { while (i < src.length && peek() !== '\n') advance(); continue; }

    const startLine = line;
    const startCol = col;
    const push = (type, value, extra = {}) =>
      tokens.push({ type, value, line: startLine, col: startCol, ...extra });

    if (c === '"') {
      advance();
      let s = '';
      while (i < src.length && peek() !== '"') {
        const ch = advance();
        if (ch === '\\') {
          const n = advance();
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
        } else s += ch;
      }
      if (i >= src.length) error('unterminated string');
      advance();
      push('string', s);
      continue;
    }

    if (/[0-9]/.test(c)) {
      let num = '';
      while (i < src.length && /[0-9]/.test(peek())) num += advance();
      let isMoney = false;
      if (peek() === '.' && /[0-9]/.test(peek(1) ?? '')) {
        isMoney = true;
        num += advance();
        let decimals = 0;
        while (i < src.length && /[0-9]/.test(peek())) { num += advance(); decimals++; }
        if (decimals > 2) error('amount supports at most 2 decimal places');
      }
      const value = isMoney ? Math.round(parseFloat(num) * 100) : parseInt(num, 10);
      push('number', value, { isMoney });
      continue;
    }

    if (/[A-Za-z]/.test(c)) {
      let word = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(peek())) word += advance();
      if ((word === 'txn' || word === 'acc') && peek() === ':') {
        advance();
        let id = '';
        while (i < src.length && /[A-Za-z0-9_.\-]/.test(peek())) id += advance();
        if (!id) error(`expected identifier after '${word}:'`);
        push(word === 'txn' ? 'txn' : 'account', id);
        continue;
      }
      if (KEYWORDS.has(word)) { push('kw', word); continue; }
      if (STATUS_WORDS.has(word)) { push('status', word); continue; }
      if (/^[a-z]/.test(word)) { push('ident', word); continue; }
      error(`unknown word '${word}'`);
    }

    const two = src.slice(i, i + 2);
    if (['==', '!=', '<=', '>='].includes(two)) {
      advance(); advance();
      push('op', two);
      continue;
    }
    if ('=<>+-*(){}[],;.'.includes(c)) {
      advance();
      push('punct', c);
      continue;
    }
    error(`unexpected character '${c}'`);
  }
  tokens.push({ type: 'eof', value: null, line, col });
  return tokens;
}
