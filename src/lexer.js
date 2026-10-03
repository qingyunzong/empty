import { DslError, E_PARSE } from './errors.js';

export const KEYWORDS = new Set([
  'trade', 'amend', 'cancel', 'deposit',
  'buy', 'sell', 'net', 'gross',
  'fee', 'qty', 'price', 'accrued', 'cash', 'at',
]);

const DATE_RE = /^\d{4}-\d{2}-\d{2}(?![\d-])/;
const NUM_RE = /^\d+(\.\d+)?/;
const VER_RE = /^v(\d+)(?![A-Za-z0-9_])/;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

// Token types: num, ver, date, id, kw, at, op, lp, rp, nl, eof
export function lexLine(text, lineNo = 1) {
  const tokens = [];
  let i = 0;
  const err = (msg, col) => new DslError(E_PARSE, `line ${lineNo}: ${msg}`, { line: lineNo, col });

  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; continue; }
    if (ch === '#') break;
    if (ch === '@') { tokens.push({ t: 'at', v: '@', col: i }); i += 1; continue; }
    if (ch === '(') { tokens.push({ t: 'lp', v: '(', col: i }); i += 1; continue; }
    if (ch === ')') { tokens.push({ t: 'rp', v: ')', col: i }); i += 1; continue; }
    if ('+-*/%'.includes(ch)) { tokens.push({ t: 'op', v: ch, col: i }); i += 1; continue; }

    const rest = text.slice(i);
    let m;
    if ((m = DATE_RE.exec(rest))) {
      tokens.push({ t: 'date', v: m[0], col: i });
      i += m[0].length;
      continue;
    }
    if ((m = NUM_RE.exec(rest))) {
      tokens.push({ t: 'num', v: m[0], col: i });
      i += m[0].length;
      continue;
    }
    if ((m = VER_RE.exec(rest))) {
      tokens.push({ t: 'ver', v: Number(m[1]), col: i });
      i += m[0].length;
      continue;
    }
    if ((m = ID_RE.exec(rest))) {
      const word = m[0];
      tokens.push(KEYWORDS.has(word)
        ? { t: 'kw', v: word, col: i }
        : { t: 'id', v: word, col: i });
      i += word.length;
      continue;
    }
    throw err(`unexpected character ${JSON.stringify(ch)}`, i);
  }
  tokens.push({ t: 'eof', v: null, col: i });
  return tokens;
}
