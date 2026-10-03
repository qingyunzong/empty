import { CorpError, E_SYNTAX } from './errors.js';

// Token kinds: DATE, CASH, NUM, IDENT, punctuation (():,+-*/), EOF.
// Keywords are recognized at parse time from IDENT values.
export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = /^\d{4}-\d{2}-\d{2}/.exec(rest))) {
      tokens.push({ t: 'DATE', v: m[0], line });
      i += m[0].length;
      continue;
    }
    if ((m = /^\$\d+(?:\.\d+)?/.exec(rest))) {
      tokens.push({ t: 'CASH', v: Number(m[0].slice(1)), line });
      i += m[0].length;
      continue;
    }
    if ((m = /^\d+(?:\.\d+)?/.exec(rest))) {
      tokens.push({ t: 'NUM', v: Number(m[0]), line });
      i += m[0].length;
      continue;
    }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) {
      tokens.push({ t: 'IDENT', v: m[0], line });
      i += m[0].length;
      continue;
    }
    if ('():,+-*/'.includes(c)) {
      tokens.push({ t: c, v: c, line });
      i++;
      continue;
    }
    throw new CorpError(E_SYNTAX, `unexpected character ${JSON.stringify(c)} at line ${line}`);
  }
  tokens.push({ t: 'EOF', v: null, line });
  return tokens;
}
