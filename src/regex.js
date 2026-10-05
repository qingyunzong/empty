'use strict';

const { RcError } = require('./errors');
const { POSITIONS, ALPHABET, TOKEN_INDEX } = require('./tokens');

// Rule regex grammar (rule length limited to 60 chars by the tool contract):
//   alt    := concat ('|' concat)*
//   concat := repeat*
//   repeat := atom ('*' | '+' | '?')*
//   atom   := '(' alt ')' | '@' name | tokenAtom
//   tokenAtom := posSpec x5   (one spec per token position)
//   posSpec := '.' | literal | '[' '^'? literal+ ']'
// A tokenAtom denotes the set of tokens matching all 5 position specs.

const LITERAL_CHARS = new Set(POSITIONS.flat());

function parse(source) {
  if (typeof source !== 'string' || source.length === 0) {
    throw new RcError('RULE_PARSE', 'empty rule');
  }
  if (source.length > 60) {
    throw new RcError('RULE_PARSE', `rule exceeds 60 chars: ${source.length}`);
  }
  let pos = 0;

  function peek() { return source[pos]; }
  function next() { return source[pos++]; }

  function parseAlt() {
    const options = [parseConcat()];
    while (peek() === '|') {
      next();
      options.push(parseConcat());
    }
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  function parseConcat() {
    const parts = [];
    while (pos < source.length && peek() !== '|' && peek() !== ')') {
      parts.push(parseRepeat());
    }
    if (parts.length === 0) return { type: 'empty' };
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  function parseRepeat() {
    let node = parseAtom();
    while (peek() === '*' || peek() === '+' || peek() === '?') {
      const op = next();
      node = { type: op === '*' ? 'star' : op === '+' ? 'plus' : 'opt', expr: node };
    }
    return node;
  }

  function parseAtom() {
    const ch = peek();
    if (ch === '(') {
      next();
      const inner = parseAlt();
      if (next() !== ')') throw new RcError('RULE_PARSE', `unbalanced '(' in: ${source}`);
      return inner;
    }
    if (ch === '@') {
      next();
      let name = '';
      while (pos < source.length && /[A-Za-z0-9_]/.test(peek())) name += next();
      if (!name) throw new RcError('RULE_PARSE', `empty @reference in: ${source}`);
      return { type: 'ref', name };
    }
    return parseTokenAtom();
  }

  function parsePosSpec(positionIndex) {
    const ch = peek();
    if (ch === undefined) {
      throw new RcError('RULE_PARSE', `truncated token atom in: ${source}`);
    }
    if (ch === '.') {
      next();
      return POSITIONS[positionIndex].slice();
    }
    if (ch === '[') {
      next();
      let negate = false;
      if (peek() === '^') { negate = true; next(); }
      const chars = [];
      while (pos < source.length && peek() !== ']') chars.push(next());
      if (next() !== ']' || chars.length === 0) {
        throw new RcError('RULE_PARSE', `bad character class in: ${source}`);
      }
      for (const c of chars) {
        if (!POSITIONS[positionIndex].includes(c)) {
          throw new RcError('RULE_PARSE', `char '${c}' invalid at position ${positionIndex} in: ${source}`);
        }
      }
      const set = negate
        ? POSITIONS[positionIndex].filter((c) => !chars.includes(c))
        : chars;
      return set;
    }
    if (LITERAL_CHARS.has(ch)) {
      next();
      if (!POSITIONS[positionIndex].includes(ch)) {
        throw new RcError('RULE_PARSE', `char '${ch}' invalid at position ${positionIndex} in: ${source}`);
      }
      return [ch];
    }
    throw new RcError('RULE_PARSE', `unexpected char '${ch}' in: ${source}`);
  }

  function parseTokenAtom() {
    const sets = [];
    for (let i = 0; i < 5; i++) sets.push(parsePosSpec(i));
    const tokens = [];
    for (const a of sets[0])
      for (const p of sets[1])
        for (const r of sets[2])
          for (const c of sets[3])
            for (const h of sets[4])
              tokens.push(a + p + r + c + h);
    tokens.sort((x, y) => TOKEN_INDEX.get(x) - TOKEN_INDEX.get(y));
    return { type: 'token', tokens };
  }

  const ast = parseAlt();
  if (pos !== source.length) {
    throw new RcError('RULE_PARSE', `trailing input at offset ${pos} in: ${source}`);
  }
  return ast;
}

module.exports = { parse };
