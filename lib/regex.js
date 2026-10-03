'use strict';

// Regex AST with concatenation, union, star, intersection and complement.
// Syntax:
//   union  := concat ('|' concat)*
//   concat := inter*
//   inter  := postfix ('&' postfix)*
//   postfix:= '~'* atom '*'*
//   atom   := '(' union ')' | '1' (epsilon) | '0' (empty language)
//           | '\' <any char> | <literal char>
// Complement (~) is only meaningful over an explicit finite alphabet.

let nextNodeId = 1;

function node(type, props) {
  return Object.assign({ id: nextNodeId++, type }, props);
}

const lit = (ch) => node('lit', { ch });
const eps = () => node('eps', {});
const emptyLang = () => node('empty', {});
const concat = (xs) => node('concat', { xs });
const alt = (xs) => node('alt', { xs });
const star = (x) => node('star', { x });
const inter = (xs) => node('inter', { xs });
const compl = (x) => node('compl', { x });

const META = new Set(['(', ')', '|', '&', '~', '*', '+', '\\']);

class RegexSyntaxError extends Error {
  constructor(msg, pos) {
    super(`regex syntax error at ${pos}: ${msg}`);
    this.name = 'RegexSyntaxError';
    this.pos = pos;
  }
}

function parse(src) {
  if (typeof src !== 'string' || src.length === 0) {
    throw new RegexSyntaxError('empty regex source', 0);
  }
  let pos = 0;

  const peek = () => src[pos];
  const skipWs = () => {
    while (src[pos] === ' ' || src[pos] === '\t') pos++;
  };

  function parseUnion() {
    const terms = [parseConcat()];
    skipWs();
    while (peek() === '|') {
      pos++;
      terms.push(parseConcat());
      skipWs();
    }
    return terms.length === 1 ? terms[0] : alt(terms);
  }

  function startsAtom(ch) {
    return ch !== undefined && ch !== '|' && ch !== ')';
  }

  function parseConcat() {
    const parts = [];
    skipWs();
    while (startsAtom(peek())) {
      parts.push(parseInter());
      skipWs();
    }
    if (parts.length === 0) return eps();
    return parts.length === 1 ? parts[0] : concat(parts);
  }

  function parseInter() {
    const factors = [parsePostfix()];
    skipWs();
    while (peek() === '&') {
      pos++;
      skipWs();
      factors.push(parsePostfix());
      skipWs();
    }
    return factors.length === 1 ? factors[0] : inter(factors);
  }

  function parsePostfix() {
    let complements = 0;
    while (peek() === '~') {
      complements++;
      pos++;
    }
    let a = parseAtom();
    for (let i = 0; i < complements; i++) a = compl(a);
    for (;;) {
      if (peek() === '*') {
        a = star(a);
        pos++;
      } else if (peek() === '+') {
        a = concat([a, star(a)]);
        pos++;
      } else {
        break;
      }
    }
    return a;
  }

  function parseAtom() {
    const ch = peek();
    if (ch === undefined) throw new RegexSyntaxError('unexpected end of input', pos);
    if (ch === '(') {
      pos++;
      const inner = parseUnion();
      if (peek() !== ')') throw new RegexSyntaxError("expected ')'", pos);
      pos++;
      return inner;
    }
    if (ch === '\\') {
      pos++;
      const esc = src[pos];
      if (esc === undefined) throw new RegexSyntaxError('dangling escape', pos);
      pos++;
      return lit(esc);
    }
    if (ch === '1') { pos++; return eps(); }
    if (ch === '0') { pos++; return emptyLang(); }
    if (ch === '|' || ch === ')' || ch === '&' || ch === '*' || ch === '+' || ch === '~') {
      throw new RegexSyntaxError(`unexpected '${ch}'`, pos);
    }
    pos++;
    return lit(ch);
  }

  const ast = parseUnion();
  skipWs();
  if (pos !== src.length) throw new RegexSyntaxError(`unexpected '${src[pos]}'`, pos);
  return ast;
}

function usesComplement(ast) {
  switch (ast.type) {
    case 'compl': return true;
    case 'concat':
    case 'alt':
    case 'inter': return ast.xs.some(usesComplement);
    case 'star': return usesComplement(ast.x);
    default: return false;
  }
}

function alphabetOf(ast, into = new Set()) {
  switch (ast.type) {
    case 'lit': into.add(ast.ch); break;
    case 'concat':
    case 'alt':
    case 'inter': for (const x of ast.xs) alphabetOf(x, into); break;
    case 'star':
    case 'compl': alphabetOf(ast.x, into); break;
  }
  return into;
}

// Independent oracle matcher: matchSet(ast, s, pos) returns the set of end
// positions e such that s.slice(pos, e) belongs to the language of ast.
// Used by tests to cross-check the automaton pipeline by full enumeration.
function matchSet(ast, s, pos) {
  switch (ast.type) {
    case 'lit':
      return s[pos] === ast.ch ? new Set([pos + 1]) : new Set();
    case 'eps':
      return new Set([pos]);
    case 'empty':
      return new Set();
    case 'concat': {
      let current = new Set([pos]);
      for (const child of ast.xs) {
        const next = new Set();
        for (const p of current) {
          for (const e of matchSet(child, s, p)) next.add(e);
        }
        current = next;
      }
      return current;
    }
    case 'alt': {
      const out = new Set();
      for (const child of ast.xs) {
        for (const e of matchSet(child, s, pos)) out.add(e);
      }
      return out;
    }
    case 'star': {
      const seen = new Set([pos]);
      const stack = [pos];
      while (stack.length > 0) {
        const p = stack.pop();
        for (const e of matchSet(ast.x, s, p)) {
          if (!seen.has(e)) {
            seen.add(e);
            stack.push(e);
          }
        }
      }
      return seen;
    }
    case 'inter': {
      let acc = null;
      for (const child of ast.xs) {
        const ends = matchSet(child, s, pos);
        acc = acc === null ? ends : new Set([...acc].filter((e) => ends.has(e)));
      }
      return acc;
    }
    case 'compl': {
      const inner = matchSet(ast.x, s, pos);
      const out = new Set();
      for (let e = pos; e <= s.length; e++) {
        if (!inner.has(e)) out.add(e);
      }
      return out;
    }
    default:
      throw new Error(`unknown node type ${ast.type}`);
  }
}

function matches(ast, s) {
  return matchSet(ast, s, 0).has(s.length);
}

module.exports = {
  parse,
  matches,
  matchSet,
  usesComplement,
  alphabetOf,
  RegexSyntaxError,
  ast: { lit, eps, emptyLang, concat, alt, star, inter, compl },
};
