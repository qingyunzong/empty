'use strict';

// Regex AST parser.
// Syntax:
//   union      := intersect ('|' intersect)*
//   intersect  := concat ('&' concat)*
//   concat     := unary*
//   unary      := '~' unary | postfix
//   postfix    := primary ('*' | '+')*
//   primary    := '(' union ')' | 'EPS' | 'NIL' | literal | '\' anychar
// EPS = epsilon language, NIL = empty language.
// '~' (complement) requires an explicit finite alphabet at compile time.

function parse(src) {
  if (typeof src !== 'string' || src.length === 0) {
    throw new SyntaxError('empty regex source');
  }
  let pos = 0;

  const peek = () => (pos < src.length ? src[pos] : null);
  const next = () => src[pos++];

  function parseUnion() {
    let node = parseIntersect();
    while (peek() === '|') {
      next();
      node = { type: 'union', left: node, right: parseIntersect() };
    }
    return node;
  }

  function parseIntersect() {
    let node = parseConcat();
    while (peek() === '&') {
      next();
      node = { type: 'intersect', left: node, right: parseConcat() };
    }
    return node;
  }

  function startsPrimary() {
    const c = peek();
    if (c === null) return false;
    if (c === '(' || c === '~' || c === '\\') return true;
    if (c === ')' || c === '|' || c === '&' || c === '*' || c === '+') return false;
    return true;
  }

  function parseConcat() {
    const parts = [];
    while (startsPrimary()) parts.push(parseUnary());
    if (parts.length === 0) return { type: 'eps' };
    return parts.reduce((acc, n) => ({ type: 'concat', left: acc, right: n }));
  }

  function parseUnary() {
    if (peek() === '~') {
      next();
      return { type: 'complement', child: parseUnary() };
    }
    let node = parsePrimary();
    for (;;) {
      const c = peek();
      if (c === '*') { next(); node = { type: 'star', child: node }; }
      else if (c === '+') { next(); node = { type: 'plus', child: node }; }
      else break;
    }
    return node;
  }

  function parsePrimary() {
    const c = peek();
    if (c === null) throw new SyntaxError(`unexpected end of regex at ${pos}`);
    if (c === '(') {
      next();
      const node = parseUnion();
      if (peek() !== ')') throw new SyntaxError(`missing ')' at ${pos}`);
      next();
      return node;
    }
    if (c === '\\') {
      next();
      const lit = next();
      if (lit === undefined) throw new SyntaxError('dangling escape at end of regex');
      return { type: 'char', ch: lit };
    }
    if (src.startsWith('EPS', pos)) { pos += 3; return { type: 'eps' }; }
    if (src.startsWith('NIL', pos)) { pos += 3; return { type: 'empty' }; }
    if (')|&*+'.includes(c)) throw new SyntaxError(`unexpected '${c}' at ${pos}`);
    next();
    return { type: 'char', ch: c };
  }

  const ast = parseUnion();
  if (pos !== src.length) throw new SyntaxError(`trailing input at ${pos}: ${src.slice(pos)}`);
  return ast;
}

function hasComplement(node) {
  switch (node.type) {
    case 'complement': return true;
    case 'union':
    case 'intersect':
    case 'concat': return hasComplement(node.left) || hasComplement(node.right);
    case 'star':
    case 'plus': return hasComplement(node.child);
    default: return false;
  }
}

function alphabetOf(node, acc = new Set()) {
  switch (node.type) {
    case 'char': acc.add(node.ch); break;
    case 'union':
    case 'intersect':
    case 'concat':
      alphabetOf(node.left, acc);
      alphabetOf(node.right, acc);
      break;
    case 'star':
    case 'plus':
    case 'complement':
      alphabetOf(node.child, acc);
      break;
    default: break;
  }
  return acc;
}

module.exports = { parse, hasComplement, alphabetOf };
