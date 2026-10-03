import { NetError, E } from './errors.js';

const KEYWORDS = new Set([
  'const', 'day', 'filter', 'nettable', 'expect', 'cycle',
  'and', 'or', 'not', 'min', 'max', 'abs', 'net',
]);

// Token kinds emitted (besides keywords and OP):
//   INT     integer cents literal            12345
//   PCT     percentage literal               2.5%   (basis points, max 2 decimals)
//   STRING  quoted string                    "USD"
//   MEMBER  member literal                   @M1
//   OBLID   obligation id literal            #O1
//   CCY     currency code (3 uppercase)      USD
//   DATE    trade date                       2026-10-04
//   IDENT   identifier (const / field name)
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const fail = (msg) => { throw new NetError(E.PARSE, `line ${line}: ${msg}`); };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    const rest = src.slice(i);
    let m;
    if ((m = /^\d{4}-\d{2}-\d{2}(?![\d-])/.exec(rest))) {
      tokens.push({ t: 'DATE', v: m[0], line }); i += m[0].length; continue;
    }
    if ((m = /^\d+(?:\.\d{1,2})?%/.exec(rest))) {
      tokens.push({ t: 'PCT', v: m[0], line }); i += m[0].length; continue;
    }
    if ((m = /^\d+/.exec(rest))) {
      tokens.push({ t: 'INT', v: m[0], line }); i += m[0].length; continue;
    }
    if ((m = /^@[A-Za-z][A-Za-z0-9_]*/.exec(rest))) {
      tokens.push({ t: 'MEMBER', v: m[0].slice(1), line }); i += m[0].length; continue;
    }
    if ((m = /^#[A-Za-z][A-Za-z0-9_-]*/.exec(rest))) {
      tokens.push({ t: 'OBLID', v: m[0].slice(1), line }); i += m[0].length; continue;
    }
    if ((m = /^"[^"\n]*"/.exec(rest))) {
      tokens.push({ t: 'STRING', v: m[0].slice(1, -1), line }); i += m[0].length; continue;
    }
    if (rest.startsWith('->')) { tokens.push({ t: 'ARROW', v: '->', line }); i += 2; continue; }
    if ((m = /^(==|!=|<=|>=)/.exec(rest))) {
      tokens.push({ t: 'OP', v: m[0], line }); i += m[0].length; continue;
    }
    if (/^[=<>+\-*/;{}(),]/.test(ch)) { tokens.push({ t: 'OP', v: ch, line }); i++; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest))) {
      const w = m[0];
      if (KEYWORDS.has(w)) tokens.push({ t: w.toUpperCase(), v: w, line });
      else if (/^[A-Z]{3}$/.test(w)) tokens.push({ t: 'CCY', v: w, line });
      else tokens.push({ t: 'IDENT', v: w, line });
      i += w.length; continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ t: 'EOF', v: '', line });
  return tokens;
}

// "2.5%" -> 250n basis points. Integer math only; >2 decimal places never lexes.
export function pctToBp(text) {
  const body = text.slice(0, -1);
  const dot = body.indexOf('.');
  if (dot === -1) return BigInt(body) * 100n;
  const whole = body.slice(0, dot);
  const frac = body.slice(dot + 1).padEnd(2, '0');
  return BigInt(whole) * 100n + BigInt(frac);
}
