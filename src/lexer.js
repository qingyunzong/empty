import { LexError } from './errors.js';

export const KEYWORDS = new Set([
  'rule', 'version', 'effective', 'for',
  'param', 'let', 'decide', 'when', 'otherwise',
  'and', 'or', 'not',
  'quantity', 'ratio', 'defect_level',
  'none', 'minor', 'major', 'critical',
  'ACCEPT', 'REJECT', 'CONTINUE',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?![\d-])/;
const NUMBER_RE = /^\d+(\.\d+)?%?/;
const BATCHNO_RE = /^#[A-Za-z0-9][A-Za-z0-9-]*/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

// Token: { type, value, line, col }
// type: 'num' | 'percent' | 'string' | 'date' | 'batchno' | 'kw' | 'ident' | 'op' | 'eof'
export function lex(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type, value, tokLine, tokCol) => tokens.push({ type, value, line: tokLine, col: tokCol });
  const fail = (msg) => { throw new LexError(msg, { line, col }); };

  while (i < source.length) {
    const ch = source[i];
    const tokLine = line;
    const tokCol = col;

    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; col += 1; continue; }
    if (ch === '\n') { i += 1; line += 1; col = 1; continue; }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { i += 1; col += 1; }
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '->' || two === '<=' || two === '>=' || two === '==' || two === '!=') {
      push('op', two, tokLine, tokCol);
      i += 2; col += 2; continue;
    }

    if ('<>+-*/(){}:=,'.includes(ch)) {
      push('op', ch, tokLine, tokCol);
      i += 1; col += 1; continue;
    }

    if (ch === '#') {
      const m = BATCHNO_RE.exec(source.slice(i));
      if (!m) fail("malformed batch number: expected '#' followed by letters/digits (e.g. #B-2024-0001)");
      push('batchno', m[0], tokLine, tokCol);
      i += m[0].length; col += m[0].length; continue;
    }

    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < source.length) {
        const c = source[j];
        if (c === '\n') break;
        if (c === '\\') {
          const nxt = source[j + 1];
          if (nxt === '"' || nxt === '\\') { out += nxt; j += 2; continue; }
          if (nxt === 'n') { out += '\n'; j += 2; continue; }
          throw new LexError(`unsupported escape '\\${nxt ?? ''}' in string`, { line, col: col + (j - i) });
        }
        if (c === '"') { closed = true; j += 1; break; }
        out += c; j += 1;
      }
      if (!closed) fail('unterminated string literal');
      push('string', out, tokLine, tokCol);
      col += j - i; i = j; continue;
    }

    if (ch >= '0' && ch <= '9') {
      const rest = source.slice(i);
      const dm = DATE_RE.exec(rest);
      if (dm) {
        push('date', dm[0], tokLine, tokCol);
        i += dm[0].length; col += dm[0].length; continue;
      }
      const nm = NUMBER_RE.exec(rest);
      const raw = nm[0];
      if (raw.endsWith('%')) {
        push('percent', raw.slice(0, -1), tokLine, tokCol);
      } else {
        push('num', raw, tokLine, tokCol);
      }
      i += raw.length; col += raw.length; continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      const m = IDENT_RE.exec(source.slice(i));
      const word = m[0];
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, tokLine, tokCol);
      i += word.length; col += word.length; continue;
    }

    fail(`unexpected character '${ch}'`);
  }

  push('eof', null, line, col);
  return tokens;
}
