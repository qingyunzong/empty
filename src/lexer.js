import { LimError, E_TYPE } from './errors.js';

export const KEYWORDS = new Set([
  'account', 'capacity', 'strategy', 'limit', 'invariant',
  'order', 'amount',
  'reserve', 'confirm', 'release',
  'history', 'op', 'invoke', 'response', 'pending', 'ok', 'fail',
  'true', 'false', 'and', 'or', 'not',
]);

const TWO_CHAR = ['<=', '>=', '==', '!=', '&&', '||'];
const ONE_CHAR = '{}();,.<>!+-*/%=';

export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const fail = (msg) => {
    throw new LimError(E_TYPE, `lexer: ${msg} at ${line}:${col}`);
  };
  const bump = () => {
    const c = src[i++];
    if (c === '\n') { line += 1; col = 1; } else { col += 1; }
    return c;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { bump(); continue; }
    if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') bump();
      continue;
    }
    if (/[0-9]/.test(c)) {
      const startLine = line; const startCol = col;
      let s = '';
      while (i < src.length && /[0-9]/.test(src[i])) s += bump();
      tokens.push({ t: 'num', v: Number(s), line: startLine, col: startCol });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const startLine = line; const startCol = col;
      let s = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) s += bump();
      tokens.push({ t: KEYWORDS.has(s) ? 'kw' : 'ident', v: s, line: startLine, col: startCol });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR.includes(two)) {
      tokens.push({ t: 'sym', v: two, line, col });
      bump(); bump();
      continue;
    }
    if (ONE_CHAR.includes(c)) {
      tokens.push({ t: 'sym', v: c, line, col });
      bump();
      continue;
    }
    fail(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ t: 'eof', v: '<eof>', line, col });
  return tokens;
}
