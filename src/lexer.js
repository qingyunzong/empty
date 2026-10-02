import { DslError } from './errors.js';

const KEYWORDS = new Set([
  'rule', 'version', 'param', 'const', 'when', 'otherwise', 'let', 'in',
  'and', 'or', 'not',
  'quantity', 'ratio', 'level', 'date', 'batch',
  'minor', 'major', 'critical',
  'ACCEPT', 'REJECT', 'CONTINUE',
]);

const TWO_CHAR_OPS = new Set(['=>', '==', '!=', '<=', '>=']);
const ONE_CHAR_OPS = new Set(['{', '}', '(', ')', ':', ',', '=', '<', '>', '+', '-', '*', '/']);

// Batch-number literal: leading uppercase letter, contains at least one digit,
// optional "-suffix" (e.g. B2024-001, LOT12). All-caps keywords carry no digit,
// so they can never collide with this pattern.
const BATCH_RE = /^[A-Z][A-Z0-9]*[0-9](?:-[0-9A-Z]+)?/;

export function tokenize(source, filename = '<input>') {
  const tokens = [];
  let pos = 0;
  let line = 1;
  const fail = (msg) => {
    throw new DslError(`${filename}:${line}: ${msg}`, line);
  };

  while (pos < source.length) {
    const ch = source[pos];
    if (ch === '\n') { line += 1; pos += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { pos += 1; continue; }
    if (ch === '#') { while (pos < source.length && source[pos] !== '\n') pos += 1; continue; }

    if (ch === '"') {
      let end = pos + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\n') fail('unterminated string literal');
        if (source[end] === '\\') {
          const next = source[end + 1];
          if (next === '"' || next === '\\') { value += next; end += 2; continue; }
          fail(`invalid escape sequence in string literal`);
        }
        value += source[end];
        end += 1;
      }
      if (end >= source.length) fail('unterminated string literal');
      tokens.push({ type: 'STRING', value, line });
      pos = end + 1;
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const rest = source.slice(pos);
      const dateMatch = rest.match(/^(\d{4})-(\d{2})-(\d{2})(?![0-9-])/);
      if (dateMatch) {
        const text = dateMatch[0];
        const yyyy = Number(dateMatch[1]);
        const mm = Number(dateMatch[2]);
        const dd = Number(dateMatch[3]);
        const dt = new Date(Date.UTC(yyyy, mm - 1, dd));
        if (mm < 1 || mm > 12 || dd < 1 || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) {
          fail(`invalid date literal '${text}'`);
        }
        tokens.push({ type: 'DATE', value: text, line });
        pos += text.length;
        continue;
      }
      const numMatch = rest.match(/^\d+(?:\.\d+)?%?/);
      const text = numMatch[0];
      if (text.endsWith('%')) {
        tokens.push({ type: 'PERCENT', value: text.slice(0, -1), line });
      } else if (text.includes('.')) {
        fail(`fractional literal '${text}' must be written as a percentage (e.g. '${text}%')`);
      } else {
        tokens.push({ type: 'NUMBER', value: text, line });
      }
      pos += text.length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const rest = source.slice(pos);
      const batchMatch = rest.match(BATCH_RE);
      if (batchMatch) {
        tokens.push({ type: 'BATCH', value: batchMatch[0], line });
        pos += batchMatch[0].length;
        continue;
      }
      const word = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/)[0];
      if (KEYWORDS.has(word)) tokens.push({ type: word, value: word, line });
      else tokens.push({ type: 'IDENT', value: word, line });
      pos += word.length;
      continue;
    }

    const two = source.slice(pos, pos + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ type: two, line }); pos += 2; continue; }
    if (ONE_CHAR_OPS.has(ch)) { tokens.push({ type: ch, line }); pos += 1; continue; }

    fail(`unexpected character '${ch}'`);
  }
  tokens.push({ type: 'EOF', line });
  return tokens;
}
