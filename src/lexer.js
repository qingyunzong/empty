import { E } from './errors.js';

const KEYWORDS = new Set(['period', 'template', 'batch', 'debit', 'credit', 'balance', 'allow']);
const SYMBOLS = '{}(),+-*/';

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const isDigit = (c) => c >= '0' && c <= '9';
  const isAlpha = (c) => /[A-Za-z_]/.test(c);
  const isAlnum = (c) => /[A-Za-z0-9_]/.test(c);

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }

    if (isDigit(c)) {
      let j = i;
      while (j < src.length && (isDigit(src[j]) || src[j] === '.')) j++;
      const text = src.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) throw E.lex(`bad number '${text}' at line ${line}`);
      tokens.push({ type: 'NUMBER', value, line });
      i = j;
      continue;
    }
    if (isAlpha(c)) {
      let j = i;
      while (j < src.length && isAlnum(src[j])) j++;
      const word = src.slice(i, j);
      tokens.push(KEYWORDS.has(word)
        ? { type: word.toUpperCase(), value: word, line }
        : { type: 'IDENT', value: word, line });
      i = j;
      continue;
    }
    if (c === '$') {
      let j = i + 1;
      if (j >= src.length || !isAlpha(src[j])) throw E.lex(`expected parameter name after '$' at line ${line}`);
      while (j < src.length && isAlnum(src[j])) j++;
      tokens.push({ type: 'VPARAM', value: src.slice(i + 1, j), line });
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < src.length && src[j] !== '"') { text += src[j]; j++; }
      if (j >= src.length) throw E.lex(`unterminated string at line ${line}`);
      tokens.push({ type: 'STRING', value: text, line });
      i = j + 1;
      continue;
    }
    if (c === '=' && src[i + 1] === '=') {
      tokens.push({ type: 'EQEQ', value: '==', line });
      i += 2;
      continue;
    }
    if (SYMBOLS.includes(c)) {
      tokens.push({ type: c, value: c, line });
      i++;
      continue;
    }
    throw E.lex(`unexpected character '${c}' at line ${line}`);
  }
  tokens.push({ type: 'EOF', line });
  return tokens;
}
