'use strict';

// Regex syntax:
//   alt    := concat ('|' concat)*
//   concat := repeat*
//   repeat := atom ('*' | '+' | '?')*
//   atom   := '(' alt ')' | '[' class ']' | '\' char | '.' | literal
// Empty concatenation (e.g. "()", "a|") is epsilon. '.' and negated
// classes range over the active alphabet of the rule library.

class RegexSyntaxError extends Error {
  constructor(message, pos) {
    super(message);
    this.name = 'RegexSyntaxError';
    this.pos = pos; // 0-based offset into the pattern
  }
}

function parse(pattern) {
  if (typeof pattern !== 'string') {
    throw new RegexSyntaxError('pattern must be a string', 0);
  }
  let i = 0;
  const peek = () => (i < pattern.length ? pattern[i] : null);
  const fail = (msg, pos) => {
    throw new RegexSyntaxError(msg, pos === undefined ? i : pos);
  };

  function parseAlt() {
    const options = [parseConcat()];
    while (peek() === '|') {
      i++;
      options.push(parseConcat());
    }
    return options.length === 1 ? options[0] : { type: 'alt', options };
  }

  function parseConcat() {
    const parts = [];
    while (peek() !== null && peek() !== '|' && peek() !== ')') {
      parts.push(parseRepeat());
    }
    if (parts.length === 0) return { type: 'eps' };
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  function parseRepeat() {
    let node = parseAtom();
    while (peek() === '*' || peek() === '+' || peek() === '?') {
      const op = peek();
      i++;
      node = { type: op === '*' ? 'star' : op === '+' ? 'plus' : 'opt', expr: node };
    }
    return node;
  }

  function parseAtom() {
    const ch = peek();
    if (ch === null) fail('unexpected end of pattern');
    if (ch === '(') {
      i++;
      const node = parseAlt();
      if (peek() !== ')') fail("expected ')'");
      i++;
      return node;
    }
    if (ch === ')') fail("unmatched ')'");
    if (ch === '[') return parseClass();
    if (ch === '\\') {
      const slashPos = i;
      i++;
      if (peek() === null) fail('dangling escape', slashPos);
      const c = pattern[i];
      i++;
      return { type: 'lit', ch: c };
    }
    if (ch === '.') {
      i++;
      return { type: 'any' };
    }
    if (ch === '*' || ch === '+' || ch === '?') {
      fail(`nothing to repeat before '${ch}'`);
    }
    i++;
    return { type: 'lit', ch };
  }

  function parseClass() {
    const startPos = i;
    i++; // consume '['
    let negate = false;
    if (peek() === '^') {
      negate = true;
      i++;
    }
    const chars = new Set();
    let first = true;
    for (;;) {
      if (peek() === null) fail('unterminated character class', startPos);
      if (peek() === ']' && !first) {
        i++;
        break;
      }
      first = false;
      let lo;
      if (peek() === '\\') {
        i++;
        if (peek() === null) fail('dangling escape', i - 1);
        lo = pattern[i];
        i++;
      } else {
        lo = pattern[i];
        i++;
      }
      if (peek() === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
        i++; // consume '-'
        let hi;
        if (peek() === '\\') {
          i++;
          if (peek() === null) fail('dangling escape', i - 1);
          hi = pattern[i];
          i++;
        } else {
          hi = pattern[i];
          i++;
        }
        if (lo > hi) fail(`invalid range '${lo}-${hi}'`, startPos);
        for (let c = lo.charCodeAt(0); c <= hi.charCodeAt(0); c++) {
          chars.add(String.fromCharCode(c));
        }
      } else {
        chars.add(lo);
      }
    }
    if (chars.size === 0) fail('empty character class', startPos);
    return { type: 'class', negate, chars: [...chars].sort() };
  }

  const ast = parseAlt();
  if (peek() !== null) fail(`unexpected '${peek()}'`);
  return ast;
}

// Collects the literal alphabet of an AST. '.', negated classes and
// epsilon contribute nothing; they range over the ambient alphabet.
function alphabetOf(ast, into) {
  const out = into || new Set();
  switch (ast.type) {
    case 'lit':
      out.add(ast.ch);
      break;
    case 'class':
      if (!ast.negate) for (const c of ast.chars) out.add(c);
      break;
    case 'concat':
      for (const p of ast.parts) alphabetOf(p, out);
      break;
    case 'alt':
      for (const o of ast.options) alphabetOf(o, out);
      break;
    case 'star':
    case 'plus':
    case 'opt':
      alphabetOf(ast.expr, out);
      break;
    default:
      break;
  }
  return out;
}

module.exports = { parse, alphabetOf, RegexSyntaxError };
