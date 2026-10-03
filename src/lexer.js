'use strict';

const { JeError } = require('./errors');

const KEYWORDS = new Set([
  'account', 'period', 'open', 'closed', 'template', 'use',
  'batch', 'in', 'on', 'post', 'dr', 'cr', 'balance', 'event',
]);

function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const fail = (msg) => {
    throw new JeError('E_PARSE', `${msg} at ${line}:${col}`);
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line += 1; col = 1; i += 1; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i += 1; col += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const startLine = line;
      i += 2; col += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') { line += 1; col = 1; } else { col += 1; }
        i += 1;
      }
      if (i >= src.length) throw new JeError('E_PARSE', `unterminated comment at ${startLine}`);
      i += 2; col += 2;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      if (!/^\d+(\.\d+)?$/.test(raw)) fail(`bad number '${raw}'`);
      tokens.push({ t: 'num', v: raw, line, col });
      col += j - i; i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      tokens.push({ t: KEYWORDS.has(word) ? 'kw' : 'ident', v: word, line, col });
      col += j - i; i = j; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') fail('unterminated string');
        if (src[j] === '\\') { out += src[j + 1]; j += 2; } else { out += src[j]; j += 1; }
      }
      if (j >= src.length) fail('unterminated string');
      tokens.push({ t: 'str', v: out, line, col });
      col += j - i + 1; i = j + 1; continue;
    }
    if (c === '=' && src[i + 1] === '=') {
      tokens.push({ t: 'punct', v: '==', line, col });
      i += 2; col += 2; continue;
    }
    if ('(){};,.+-*/'.includes(c)) {
      tokens.push({ t: 'punct', v: c, line, col });
      i += 1; col += 1; continue;
    }
    fail(`unexpected character '${c}'`);
  }
  tokens.push({ t: 'eof', v: '<eof>', line, col });
  return tokens;
}

module.exports = { lex };
