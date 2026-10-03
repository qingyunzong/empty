import { DslError } from './errors.js';

export const TT = {
  NUM: 'num',
  TIME: 'time',
  IDENT: 'ident',
  PUNCT: 'punct',
  EOF: 'eof',
};

const PUNCT1 = new Set(['{', '}', '(', ')', '[', ']', ',', ':', '+', '-', '*', '/', '=']);
const IDENT_START = /[A-Za-z_元]/;
const IDENT_PART = /[A-Za-z0-9_元]/;

export function lex(src, file = '<input>') {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const push = (type, value, startLine, startCol) => {
    tokens.push({ type, value, file, line: startLine, col: startCol });
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      col += 1;
      continue;
    }
    if (c === '\n') {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    const startLine = line;
    const startCol = col;
    if (/[0-9]/.test(c)) {
      const rest = src.slice(i);
      const tm = /^(\d{1,2}):(\d{2})(?![0-9])/.exec(rest);
      if (tm) {
        push(TT.TIME, tm[0], startLine, startCol);
        i += tm[0].length;
        col += tm[0].length;
        continue;
      }
      const nm = /^\d+(\.\d+)?/.exec(rest);
      push(TT.NUM, nm[0], startLine, startCol);
      i += nm[0].length;
      col += nm[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < src.length && IDENT_PART.test(src[j])) j += 1;
      const word = src.slice(i, j);
      push(TT.IDENT, word, startLine, startCol);
      col += j - i;
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '..' || two === '->') {
      push(TT.PUNCT, two, startLine, startCol);
      i += 2;
      col += 2;
      continue;
    }
    if (PUNCT1.has(c)) {
      push(TT.PUNCT, c, startLine, startCol);
      i += 1;
      col += 1;
      continue;
    }
    throw new DslError(`unexpected character '${c}'`, { file, line, col });
  }
  push(TT.EOF, '<eof>', line, col);
  return tokens;
}
