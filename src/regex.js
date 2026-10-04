'use strict';

class FlowError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

// AST node kinds: lit{v}, eps, empty, cat{a,b}, alt{a,b}, star{x}

const EPS = Object.freeze({ k: 'eps' });
const EMPTY = Object.freeze({ k: 'empty' });

function cat(a, b) {
  if (a.k === 'empty' || b.k === 'empty') return EMPTY;
  if (a.k === 'eps') return b;
  if (b.k === 'eps') return a;
  return { k: 'cat', a, b };
}

function alt(a, b) {
  if (a.k === 'empty') return b;
  if (b.k === 'empty') return a;
  return { k: 'alt', a, b };
}

function star(x) {
  if (x.k === 'empty' || x.k === 'eps') return EPS;
  return { k: 'star', x };
}

const META = new Set(['(', ')', '|', '*', '+', '?']);

function tokenize(src) {
  const toks = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === '.' || c === ',') { i++; continue; }
    if (META.has(c)) { toks.push({ t: c }); i++; continue; }
    if (c === 'ε') { toks.push({ t: 'eps' }); i++; continue; }
    if (c === '∅') { toks.push({ t: 'empty' }); i++; continue; }
    let j = i;
    while (j < src.length) {
      const d = src[j];
      if (/\s/.test(d) || META.has(d) || d === 'ε' || d === '∅' || d === '.' || d === ',') break;
      j++;
    }
    toks.push({ t: 'lit', v: src.slice(i, j) });
    i = j;
  }
  return toks;
}

// grammar: alt := cat ('|' cat)* ; cat := rep* ; rep := atom ('*'|'+'|'?')* ;
// atom := '(' alt ')' | lit | eps | empty
// raw constructors for the parser: no simplification, so the alphabet
// (set of literals) is preserved even when the language is empty
const catR = (a, b) => ({ k: 'cat', a, b });
const altR = (a, b) => ({ k: 'alt', a, b });
const starR = (x) => ({ k: 'star', x });

function parse(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => (pos < toks.length ? toks[pos] : null);

  function parseAlt() {
    let node = parseCat();
    while (peek() && peek().t === '|') {
      pos++;
      node = altR(node, parseCat());
    }
    return node;
  }

  function parseCat() {
    let node = null;
    while (peek() && peek().t !== '|' && peek().t !== ')') {
      const piece = parseRep();
      node = node === null ? piece : catR(node, piece);
    }
    return node === null ? EPS : node;
  }

  function parseRep() {
    let node = parseAtom();
    while (peek() && (peek().t === '*' || peek().t === '+' || peek().t === '?')) {
      const op = toks[pos++].t;
      if (op === '*') node = starR(node);
      else if (op === '+') node = catR(node, starR(node));
      else node = altR(node, EPS);
    }
    return node;
  }

  function parseAtom() {
    const t = peek();
    if (!t) throw new FlowError('BAD_REGEX', 'unexpected end of regex');
    if (t.t === '(') {
      pos++;
      const node = parseAlt();
      if (!peek() || peek().t !== ')') throw new FlowError('BAD_REGEX', 'missing )');
      pos++;
      return node;
    }
    pos++;
    if (t.t === 'lit') return { k: 'lit', v: t.v };
    if (t.t === 'eps') return EPS;
    if (t.t === 'empty') return EMPTY;
    throw new FlowError('BAD_REGEX', `unexpected token ${t.t}`);
  }

  const ast = parseAlt();
  if (pos !== toks.length) throw new FlowError('BAD_REGEX', 'trailing tokens');
  return ast;
}

function literals(ast) {
  const out = new Set();
  (function walk(n) {
    if (n.k === 'lit') out.add(n.v);
    else if (n.k === 'cat' || n.k === 'alt') { walk(n.a); walk(n.b); }
    else if (n.k === 'star') walk(n.x);
  })(ast);
  return [...out].sort();
}

function nullable(n) {
  switch (n.k) {
    case 'eps': return true;
    case 'empty': case 'lit': return false;
    case 'alt': return nullable(n.a) || nullable(n.b);
    case 'cat': return nullable(n.a) && nullable(n.b);
    case 'star': return true;
    default: throw new Error(`bad node ${n.k}`);
  }
}

// Brzozowski derivative; independent matcher used to cross-check the DFA.
function derive(n, ev) {
  switch (n.k) {
    case 'lit': return n.v === ev ? EPS : EMPTY;
    case 'eps': case 'empty': return EMPTY;
    case 'alt': return alt(derive(n.a, ev), derive(n.b, ev));
    case 'cat':
      return nullable(n.a)
        ? alt(cat(derive(n.a, ev), n.b), derive(n.b, ev))
        : cat(derive(n.a, ev), n.b);
    case 'star': return cat(derive(n.x, ev), n);
    default: throw new Error(`bad node ${n.k}`);
  }
}

function derivMatch(ast, events) {
  let cur = ast;
  for (const e of events) cur = derive(cur, e);
  return nullable(cur);
}

module.exports = { FlowError, parse, literals, nullable, derive, derivMatch, EPS, EMPTY };
