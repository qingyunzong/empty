import { NetError, E } from './errors.js';

const KEYWORDS = new Set([
  'date', 'const', 'filter', 'settle',
  'and', 'or', 'not', 'min', 'max', 'abs',
  'true', 'false',
]);

const SINGLE = {
  '(': 'LP', ')': 'RP', '{': 'LB', '}': 'RB',
  ';': 'SEMI', ',': 'COMMA', '.': 'DOT',
  '+': 'PLUS', '-': 'MINUS', '*': 'STAR', '=': 'ASSIGN',
};

// Percentage literal text (e.g. "2.5") -> integer basis points (250).
// No floating point is ever used for money or rates.
export function toBps(text) {
  const [whole, frac = ''] = text.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new NetError(E.PARSE, `unterminated comment at line ${line}`);
      line += src.slice(i, end + 2).split('\n').length - 1;
      i = end + 2;
      continue;
    }
    const rest = src.slice(i);
    let m;
    if ((m = /^(\d{4}-\d{2}-\d{2})/.exec(rest))) {
      tokens.push({ t: 'DATE', v: m[1], line });
      i += m[1].length;
      continue;
    }
    if ((m = /^(\d+(?:\.\d{1,2})?)%/.exec(rest))) {
      tokens.push({ t: 'PCT', v: toBps(m[1]), line });
      i += m[0].length;
      continue;
    }
    if ((m = /^\d+/.exec(rest))) {
      tokens.push({ t: 'INT', v: Number(m[0]), line });
      i += m[0].length;
      continue;
    }
    if ((m = /^@[A-Za-z][A-Za-z0-9_]*/.exec(rest))) {
      tokens.push({ t: 'MEMBER', v: m[0].slice(1), line });
      i += m[0].length;
      continue;
    }
    if ((m = /^#[A-Za-z0-9_-]+/.exec(rest))) {
      tokens.push({ t: 'OBID', v: m[0].slice(1), line });
      i += m[0].length;
      continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const w = m[0];
      if (KEYWORDS.has(w)) tokens.push({ t: w.toUpperCase(), line });
      else if (/^[A-Z]{3}$/.test(w)) tokens.push({ t: 'CCY', v: w, line });
      else tokens.push({ t: 'IDENT', v: w, line });
      i += w.length;
      continue;
    }
    if (src.startsWith('==', i)) { tokens.push({ t: 'EQ', line }); i += 2; continue; }
    if (src.startsWith('!=', i)) { tokens.push({ t: 'NE', line }); i += 2; continue; }
    if (src.startsWith('<=', i)) { tokens.push({ t: 'LE', line }); i += 2; continue; }
    if (src.startsWith('>=', i)) { tokens.push({ t: 'GE', line }); i += 2; continue; }
    if (ch === '<') { tokens.push({ t: 'LT', line }); i++; continue; }
    if (ch === '>') { tokens.push({ t: 'GT', line }); i++; continue; }
    if (SINGLE[ch]) { tokens.push({ t: SINGLE[ch], line }); i++; continue; }
    throw new NetError(E.PARSE, `unexpected character '${ch}' at line ${line}`);
  }
  tokens.push({ t: 'EOF', line });
  return tokens;
}
