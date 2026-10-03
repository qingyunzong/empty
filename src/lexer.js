'use strict';

const { QuerySyntaxError } = require('./errors');

const KEYWORDS = new Set(['and', 'or', 'not']);
const BARE_WORD_STOP = /[\s()"'/:<>!=]/;

function readPhrase(input, start) {
  const quote = input[start];
  let out = '';
  let i = start + 1;
  while (i < input.length && input[i] !== quote) {
    if (input[i] === '\\' && i + 1 < input.length) {
      out += input[i + 1];
      i += 2;
    } else {
      out += input[i];
      i += 1;
    }
  }
  if (i >= input.length) {
    throw new QuerySyntaxError(`unterminated quoted phrase at position ${start}`);
  }
  return { value: out, end: i + 1 };
}

function readRegex(input, start) {
  let pattern = '';
  let i = start + 1;
  while (i < input.length && input[i] !== '/') {
    if (input[i] === '\\' && i + 1 < input.length) {
      pattern += input[i] + input[i + 1];
      i += 2;
    } else {
      pattern += input[i];
      i += 1;
    }
  }
  if (i >= input.length) {
    throw new QuerySyntaxError(`unterminated regex literal at position ${start}`);
  }
  let flags = '';
  let j = i + 1;
  while (j < input.length && /[a-z]/.test(input[j])) {
    flags += input[j];
    j += 1;
  }
  return { pattern, flags, end: j };
}

function tokenize(input) {
  if (typeof input !== 'string') {
    throw new QuerySyntaxError('query must be a string');
  }
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '(') { tokens.push({ type: 'LPAREN', value: '(', pos: i }); i += 1; continue; }
    if (ch === ')') { tokens.push({ type: 'RPAREN', value: ')', pos: i }); i += 1; continue; }
    if (ch === ':') { tokens.push({ type: 'COLON', value: ':', pos: i }); i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const { value, end } = readPhrase(input, i);
      tokens.push({ type: 'PHRASE', value, pos: i });
      i = end;
      continue;
    }
    if (ch === '/') {
      const { pattern, flags, end } = readRegex(input, i);
      tokens.push({ type: 'REGEX', value: pattern, flags, pos: i });
      i = end;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '=' || ch === '!') {
      const two = input.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '!=') {
        tokens.push({ type: 'OP', value: two, pos: i });
        i += 2;
        continue;
      }
      if (ch === '<' || ch === '>' || ch === '=') {
        tokens.push({ type: 'OP', value: ch, pos: i });
        i += 1;
        continue;
      }
      throw new QuerySyntaxError(`unexpected character '!' at position ${i}`);
    }
    let j = i;
    while (j < input.length && !BARE_WORD_STOP.test(input[j])) j += 1;
    if (j === i) {
      throw new QuerySyntaxError(`unexpected character '${ch}' at position ${i}`);
    }
    const word = input.slice(i, j);
    const lower = word.toLowerCase();
    if (KEYWORDS.has(lower)) {
      tokens.push({ type: lower.toUpperCase(), value: lower, pos: i });
    } else {
      tokens.push({ type: 'WORD', value: word, pos: i });
    }
    i = j;
  }
  tokens.push({ type: 'EOF', pos: input.length });
  return tokens;
}

module.exports = { tokenize };
