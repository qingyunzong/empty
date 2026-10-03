import { lexError } from './errors.js';

export const KEYWORDS = new Set([
  'contract', 'defaults', 'tier', 'on', 'min', 'max', 'fee', 'rounding',
  'residual', 'to', 'order', 'override', 'HALF_UP', 'HALF_EVEN', 'DOWN',
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER_RE = /^\d+(\.\d+)?/;

export function tokenize(source) {
  const tokens = [];
  let i = 0, line = 1, col = 1;
  const push = (type, value, extra = {}) => tokens.push({ type, value, line, col, ...extra });

  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; col = 1; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') { i++; col++; } continue; }
    if (ch === ';') { i++; col++; continue; }

    if (ch === '.' && /\d/.test(source[i + 1] ?? '')) {
      throw lexError(`malformed number at ${line}:${col}: leading '.' is not allowed`);
    }

    const numMatch = source.slice(i).match(NUMBER_RE);
    if (numMatch && /\d/.test(ch)) {
      const text = numMatch[0];
      const after = source.slice(i + text.length);
      const suffix = after.match(/^(bps|units|[A-Z]{3})(?![A-Za-z0-9_])/);
      if (!suffix && /^[A-Za-z0-9_.]/.test(after)) {
        throw lexError(`malformed number at ${line}:${col}: ${text}${after.match(/^[^\s;]+/)[0]}`);
      }
      push('NUMBER', text);
      i += text.length; col += text.length;
      continue;
    }

    const idMatch = source.slice(i).match(IDENT_RE);
    if (idMatch) {
      const word = idMatch[0];
      if (KEYWORDS.has(word)) push('KEYWORD', word);
      else if (word === 'bps') push('BPS', word);
      else if (word === 'units') push('UNITS', word);
      else if (/^[A-Z]{3}$/.test(word)) push('CURRENCY', word);
      else push('IDENT', word);
      i += word.length; col += word.length;
      continue;
    }

    if (ch === '"') {
      const end = source.indexOf('"', i + 1);
      if (end === -1) throw lexError(`unterminated string at ${line}:${col}`);
      const text = source.slice(i + 1, end);
      if (/[\n]/.test(text)) throw lexError(`unterminated string at ${line}:${col}`);
      push('STRING', text);
      col += (end - i + 1); i = end + 1;
      continue;
    }

    if ('(){}[],:=+'.includes(ch)) { push('PUNCT', ch); i++; col++; continue; }

    throw lexError(`unexpected character ${JSON.stringify(ch)} at ${line}:${col}`);
  }

  push('EOF', null);
  return tokens;
}
