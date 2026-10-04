'use strict';

const { DslError } = require('./errors');

const KEYWORDS = new Set([
  'let', 'rule', 'return', 'if', 'then', 'else',
  'and', 'or', 'not', 'true', 'false', 'round',
]);
const TYPE_NAMES = new Set(['money', 'rate', 'date', 'bool']);

function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isIdentStart(ch) { return /[A-Za-z_]/.test(ch); }
function isIdentPart(ch) { return /[A-Za-z0-9_]/.test(ch); }

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const err = (msg, l = line, c = col) => { throw new DslError('E_LEX', msg, l, c); };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') { i++; line++; col = 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }
    if (ch === '#' || (ch === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') { i++; col++; }
      continue;
    }
    const startLine = line;
    const startCol = col;

    if (isDigit(ch)) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === '-' && j - i === 4 && isDigit(src[j + 1] || '')) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(src.slice(i));
        if (m) {
          const y = Number(m[1]);
          const mo = Number(m[2]);
          const d = Number(m[3]);
          if (!validDate(y, mo, d)) err(`invalid date literal '${m[0]}'`, startLine, startCol);
          tokens.push({ t: 'DATE', v: m[0], line: startLine, col: startCol });
          col += m[0].length;
          i += m[0].length;
          continue;
        }
      }
      if (src[j] === '.' && isDigit(src[j + 1] || '')) {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        err('scientific notation is not allowed in numeric literals', startLine, startCol);
      }
      const text = src.slice(i, j);
      const decimals = text.includes('.') ? text.split('.')[1].length : 0;
      if (src[j] === 'm') {
        if (decimals > 2) {
          err(`money literal '${text}m' has more than 2 decimal places`, startLine, startCol);
        }
        tokens.push({ t: 'MONEY', v: text, line: startLine, col: startCol });
        j++;
      } else {
        if (decimals > 6) {
          err(`rate literal '${text}' has more than 6 decimal places`, startLine, startCol);
        }
        tokens.push({ t: 'RATE', v: text, line: startLine, col: startCol });
      }
      col += j - i;
      i = j;
      continue;
    }

    if (isIdentStart(ch)) {
      let j = i;
      while (j < src.length && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      let t = 'IDENT';
      if (KEYWORDS.has(word)) t = word;
      else if (TYPE_NAMES.has(word)) t = 'TYPE';
      tokens.push({ t, v: word, line: startLine, col: startCol });
      col += j - i;
      i = j;
      continue;
    }

    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '->') {
      tokens.push({ t: two, v: two, line: startLine, col: startCol });
      i += 2;
      col += 2;
      continue;
    }
    if ('(){}:;,=<>+-*'.includes(ch)) {
      tokens.push({ t: ch, v: ch, line: startLine, col: startCol });
      i++;
      col++;
      continue;
    }
    err(`unexpected character '${ch}'`, startLine, startCol);
  }
  tokens.push({ t: 'EOF', v: '', line, col });
  return tokens;
}

module.exports = { lex };
