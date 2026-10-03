'use strict';

// Regex syntax (subset, single-character alphabet letters):
//   expr   := alt
//   alt    := cat ('|' cat)*
//   cat    := repeat*
//   repeat := atom ('*' | '+' | '?')*
//   atom   := '(' alt ')' | '\' <any char> | <any char except | ( ) * + ? \>
// Empty pattern / empty group is epsilon. '.' has no special meaning.

class RegexSyntaxError extends Error {
  constructor(message, index, pattern) {
    super(message);
    this.name = 'RegexSyntaxError';
    this.index = index; // 0-based offset into the pattern
    this.pattern = pattern;
  }
}

// AST nodes:
//   { type: 'eps' }
//   { type: 'lit', char }
//   { type: 'cat', parts: [node, ...] }      (parts.length >= 2)
//   { type: 'alt', branches: [node, ...] }   (branches.length >= 2)
//   { type: 'star' | 'plus' | 'opt', child }
function parse(pattern) {
  if (typeof pattern !== 'string') {
    throw new TypeError('pattern must be a string');
  }
  let pos = 0;
  const n = pattern.length;
  const peek = () => (pos < n ? pattern[pos] : null);

  function parseAlt() {
    const branches = [parseCat()];
    while (peek() === '|') {
      pos++;
      branches.push(parseCat());
    }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  }

  function parseCat() {
    const parts = [];
    while (pos < n && peek() !== '|' && peek() !== ')') {
      parts.push(parseRepeat());
    }
    if (parts.length === 0) return { type: 'eps' };
    if (parts.length === 1) return parts[0];
    return { type: 'cat', parts };
  }

  function parseRepeat() {
    let node = parseAtom();
    for (;;) {
      const c = peek();
      if (c === '*') { pos++; node = { type: 'star', child: node }; }
      else if (c === '+') { pos++; node = { type: 'plus', child: node }; }
      else if (c === '?') { pos++; node = { type: 'opt', child: node }; }
      else break;
    }
    return node;
  }

  function parseAtom() {
    const c = peek();
    if (c === null) {
      throw new RegexSyntaxError('unexpected end of pattern', pos, pattern);
    }
    if (c === '(') {
      pos++;
      const inner = parseAlt();
      if (peek() !== ')') {
        throw new RegexSyntaxError("missing ')'", pos, pattern);
      }
      pos++;
      return inner;
    }
    if (c === ')') {
      throw new RegexSyntaxError("unmatched ')'", pos, pattern);
    }
    if (c === '*' || c === '+' || c === '?') {
      throw new RegexSyntaxError(`nothing to repeat before '${c}'`, pos, pattern);
    }
    if (c === '\\') {
      pos++;
      if (pos >= n) {
        throw new RegexSyntaxError('trailing backslash', pos - 1, pattern);
      }
      const lit = pattern[pos];
      pos++;
      return { type: 'lit', char: lit };
    }
    pos++;
    return { type: 'lit', char: c };
  }

  const ast = parseAlt();
  if (pos < n) {
    throw new RegexSyntaxError("unmatched ')'", pos, pattern);
  }
  return ast;
}

function literalsOf(ast, out) {
  const set = out || new Set();
  switch (ast.type) {
    case 'lit':
      set.add(ast.char);
      break;
    case 'cat':
      for (const p of ast.parts) literalsOf(p, set);
      break;
    case 'alt':
      for (const b of ast.branches) literalsOf(b, set);
      break;
    case 'star':
    case 'plus':
    case 'opt':
      literalsOf(ast.child, set);
      break;
    default:
      break;
  }
  return set;
}

module.exports = { parse, literalsOf, RegexSyntaxError };
