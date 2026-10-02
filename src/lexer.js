'use strict';

const { QueryError } = require('./errors');

const KEYWORDS = new Set([
  'let', 'select', 'where', 'and', 'or', 'not', 'matches',
  'count', 'sum', 'avg', 'min', 'max', 'true', 'false',
]);

const NUMBER_UNITS = {
  '': 1,
  k: 1e3, M: 1e6, G: 1e9,
  KB: 1e3, MB: 1e6, GB: 1e9,
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3,
  ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000,
};

const TIME_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?/;
const NUMBER_RE = /^\d+(?:\.\d+)?(?:[A-Za-z]+)?/;
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function parseTimeLiteral(text, pos) {
  let iso = text;
  if (!iso.includes('T')) {
    iso += 'T00:00:00Z';
  } else if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(iso)) {
    iso += 'Z';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new QueryError(`invalid time literal '${text}'`, pos);
  }
  return ms;
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    const rest = src.slice(i);
    const timeMatch = TIME_RE.exec(rest);
    if (timeMatch) {
      tokens.push({ type: 'time', value: parseTimeLiteral(timeMatch[0], i), pos: i });
      i += timeMatch[0].length;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      const m = NUMBER_RE.exec(rest);
      const numPart = m[0].replace(/[A-Za-z]+$/, '');
      const unit = m[0].slice(numPart.length);
      const mult = NUMBER_UNITS[unit];
      if (mult === undefined) {
        throw new QueryError(`unknown numeric unit '${unit}'`, i);
      }
      tokens.push({ type: 'num', value: parseFloat(numPart) * mult, pos: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
          const nxt = src[j + 1];
          if (nxt === '"' || nxt === '\\') out += nxt;
          else if (nxt === 'n') out += '\n';
          else if (nxt === 't') out += '\t';
          else throw new QueryError(`invalid escape '\\${nxt}'`, j);
          j += 2;
          continue;
        }
        if (c === '"') { closed = true; j++; break; }
        out += c;
        j++;
      }
      if (!closed) throw new QueryError('unterminated string literal', i);
      tokens.push({ type: 'str', value: out, pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ type: 'op', value: two, pos: i });
      i += 2;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '=' || ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
      continue;
    }
    const identMatch = IDENT_RE.exec(rest);
    if (identMatch) {
      const word = identMatch[0];
      tokens.push({
        type: KEYWORDS.has(word) ? 'kw' : 'ident',
        value: word,
        pos: i,
      });
      i += word.length;
      continue;
    }
    throw new QueryError(`unexpected character '${ch}'`, i);
  }
  tokens.push({ type: 'eof', value: null, pos: src.length });
  return tokens;
}

module.exports = { tokenize, NUMBER_UNITS };
