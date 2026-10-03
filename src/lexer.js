import { EscrowError } from './errors.js';

const KEYWORDS = new Set(['trade', 'amend', 'revoke', 'on', 'buy', 'sell', 'net', 'gross', 'fee']);
const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
const VERSION_RE = /^v[0-9]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(?![\d-])/;
const NUMBER_RE = /^\d+(\.\d+)?/;
const WORD_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

const SINGLE = {
  '@': 'AT', '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '/': 'SLASH',
  '(': 'LPAREN', ')': 'RPAREN',
};

export function lex(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (SINGLE[c]) { tokens.push({ t: SINGLE[c], pos: i }); i++; continue; }
    if (/[0-9]/.test(c)) {
      const dm = DATE_RE.exec(src.slice(i));
      if (dm) { tokens.push({ t: 'DATE', v: dm[0], pos: i }); i += dm[0].length; continue; }
      const nm = NUMBER_RE.exec(src.slice(i));
      if (!nm) throw new EscrowError('E_PARSE', `bad number at offset ${i}`);
      tokens.push({ t: 'NUMBER', v: parseFloat(nm[0]), pos: i });
      i += nm[0].length;
      continue;
    }
    const wm = WORD_RE.exec(src.slice(i));
    if (wm) {
      const w = wm[0];
      if (KEYWORDS.has(w)) tokens.push({ t: 'KW', v: w, pos: i });
      else if (VERSION_RE.test(w)) tokens.push({ t: 'VERSION', v: Number(w.slice(1)), pos: i });
      else if (ISIN_RE.test(w)) tokens.push({ t: 'ISIN', v: w, pos: i });
      else tokens.push({ t: 'IDENT', v: w, pos: i });
      i += w.length;
      continue;
    }
    throw new EscrowError('E_PARSE', `unexpected character ${JSON.stringify(c)} at offset ${i}`);
  }
  tokens.push({ t: 'EOF', pos: src.length });
  return tokens;
}
