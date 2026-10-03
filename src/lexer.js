import { CaError } from './errors.js';

// Tokens: ident, number, cash ($2.50), shares (100sh), date (YYYY-MM-DD), punct, eof.
export function tokenize(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const push = (type, value, startCol) => tokens.push({ type, value, line, col: startCol });

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line++;
      col = 1;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      col++;
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const startCol = col;
    if (/[0-9]/.test(c)) {
      const rest = src.slice(i);
      let m = /^(\d{4}-\d{2}-\d{2})\b/.exec(rest);
      if (m) {
        push('date', m[1], startCol);
        i += m[1].length;
        col += m[1].length;
        continue;
      }
      m = /^(\d+(?:\.\d+)?)/.exec(rest);
      const num = m[1];
      const j = i + num.length;
      if (src.slice(j, j + 2) === 'sh' && !/[A-Za-z0-9_]/.test(src[j + 2] || '')) {
        push('shares', num, startCol);
        i = j + 2;
        col += num.length + 2;
        continue;
      }
      push('number', num, startCol);
      i = j;
      col += num.length;
      continue;
    }
    if (c === '$') {
      const m = /^\$(\d+(?:\.\d+)?)/.exec(src.slice(i));
      if (!m) throw new CaError('E_PARSE', `invalid cash literal at ${line}:${col}`);
      push('cash', m[1], startCol);
      i += 1 + m[1].length;
      col += 1 + m[1].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
      push('ident', m[0], startCol);
      i += m[0].length;
      col += m[0].length;
      continue;
    }
    if ('{}()+*/,-'.includes(c)) {
      push('punct', c, startCol);
      i++;
      col++;
      continue;
    }
    throw new CaError('E_PARSE', `unexpected character '${c}' at ${line}:${col}`);
  }
  tokens.push({ type: 'eof', value: '', line, col });
  return tokens;
}
