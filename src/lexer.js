import { QError } from './errors.js';

const KEYWORDS = new Set([
  'customer', 'note', 'bucket', 'limit', 'approval', 'cap', 'let', 'reject',
  'when', 'unless', 'freeze', 'unfreeze', 'debit', 'available', 'frozen',
  'used', 'and', 'or', 'not', 'matches', 'valid', 'to', 'true', 'false',
  'amount',
]);

// Token kinds: KW, IDENT, CUSTOMER (e.g. C0001), NUMBER, STRING, DATE
// (YYYY-MM-DD validity period), REGEX (note whitelist literal), PUNCT, EOF.
export function tokenize(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  let prev = null;
  const push = (t) => { toks.push(t); prev = t; };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new QError('E_LEX', `unterminated comment at line ${line}`);
      line += src.slice(i, end).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    // Regex literal: only directly after the `note` or `matches` keyword.
    if (c === '/' && prev && prev.type === 'KW' && (prev.value === 'note' || prev.value === 'matches')) {
      let j = i + 1;
      let re = '';
      while (j < src.length && src[j] !== '/') {
        if (src[j] === '\\') { re += src[j] + (src[j + 1] ?? ''); j += 2; }
        else if (src[j] === '\n') throw new QError('E_LEX', `unterminated regex at line ${line}`);
        else { re += src[j]; j++; }
      }
      if (j >= src.length) throw new QError('E_LEX', `unterminated regex at line ${line}`);
      push({ type: 'REGEX', value: re, line });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '->') {
      push({ type: 'PUNCT', value: two, line });
      i += 2;
      continue;
    }
    if ('{}();,<>+-*/='.includes(c)) { push({ type: 'PUNCT', value: c, line }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; } else { s += src[j]; j++; }
      }
      if (j >= src.length) throw new QError('E_LEX', `unterminated string at line ${line}`);
      push({ type: 'STRING', value: s, line });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    let m;
    if ((m = rest.match(/^\d{4}-\d{2}-\d{2}(?![\d-])/))) {
      push({ type: 'DATE', value: m[0], line });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^\d+(\.\d+)?/))) {
      push({ type: 'NUMBER', value: Number(m[0]), line });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^[A-Z]\d{4,8}(?!\d)/))) {
      push({ type: 'CUSTOMER', value: m[0], line });
      i += m[0].length;
      continue;
    }
    if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
      const w = m[0];
      push(KEYWORDS.has(w) ? { type: 'KW', value: w, line } : { type: 'IDENT', value: w, line });
      i += w.length;
      continue;
    }
    throw new QError('E_LEX', `unexpected character '${c}' at line ${line}`);
  }
  toks.push({ type: 'EOF', value: null, line });
  return toks;
}
