'use strict';

const { parseError } = require('./errors');

// Token kinds: num, ident, op, lparen, rparen, comma, eof
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      const value = Number(text);
      if (Number.isNaN(value)) throw parseError(`invalid number "${text}"`, i);
      tokens.push({ kind: 'num', value, start: i, end: j });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ kind: 'ident', value: src.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) {
      tokens.push({ kind: 'op', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/=<>'.includes(ch)) {
      tokens.push({ kind: 'op', value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === '(') { tokens.push({ kind: 'lparen', value: ch, start: i, end: i + 1 }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'rparen', value: ch, start: i, end: i + 1 }); i++; continue; }
    if (ch === ',') { tokens.push({ kind: 'comma', value: ch, start: i, end: i + 1 }); i++; continue; }
    throw parseError(`unexpected character "${ch}"`, i);
  }
  tokens.push({ kind: 'eof', value: null, start: src.length, end: src.length });
  return tokens;
}

// Binding powers for the Pratt parser.
const BINARY_BP = {
  '<': 5, '>': 5, '<=': 5, '>=': 5, '==': 5, '!=': 5,
  '+': 10, '-': 10,
  '*': 20, '/': 20,
};
const UNARY_BP = 30;

function parseFormula(src) {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function expect(kind, what) {
    const tok = peek();
    if (tok.kind !== kind) {
      throw parseError(`expected ${what} but found ${describe(tok)}`, tok.start);
    }
    return next();
  }

  function describe(tok) {
    if (tok.kind === 'eof') return 'end of input';
    if (tok.kind === 'rparen') return '")"';
    if (tok.kind === 'lparen') return '"("';
    return `"${tok.value}"`;
  }

  // Pratt expression parser: nud for prefixes, led for infixes.
  function parseExpr(minBp) {
    const tok = next();
    let left;
    if (tok.kind === 'num') {
      left = { type: 'Number', value: tok.value, start: tok.start, end: tok.end };
    } else if (tok.kind === 'ident') {
      if (peek().kind === 'lparen') {
        const open = next();
        const args = [];
        if (peek().kind !== 'rparen') {
          args.push(parseExpr(0));
          while (peek().kind === 'comma') { next(); args.push(parseExpr(0)); }
        }
        const close = expect('rparen', '")" to close call');
        left = { type: 'Call', name: tok.value, args, start: tok.start, end: close.end };
        void open;
      } else {
        left = { type: 'Var', name: tok.value, start: tok.start, end: tok.end };
      }
    } else if (tok.kind === 'op' && tok.value === '-') {
      const arg = parseExpr(UNARY_BP);
      left = { type: 'Unary', op: '-', arg, start: tok.start, end: arg.end };
    } else if (tok.kind === 'op' && tok.value === '+') {
      left = parseExpr(UNARY_BP);
    } else if (tok.kind === 'lparen') {
      left = parseExpr(0);
      const close = expect('rparen', '")"');
      left = { ...left, start: tok.start, end: close.end };
    } else if (tok.kind === 'rparen') {
      throw parseError('unmatched ")"', tok.start);
    } else if (tok.kind === 'eof') {
      throw parseError('unexpected end of input, expected an expression', tok.start);
    } else {
      throw parseError(`unexpected ${describe(tok)}`, tok.start);
    }

    for (;;) {
      const op = peek();
      if (op.kind !== 'op' || op.value === '=') break;
      const bp = BINARY_BP[op.value];
      if (bp === undefined || bp < minBp) break;
      next();
      const right = parseExpr(bp + 1);
      left = { type: 'Binary', op: op.value, left, right, start: left.start, end: right.end, opStart: op.start };
    }
    return left;
  }

  // Optional top-level assignment: `name = expr`.
  let node;
  if (tokens[0].kind === 'ident' && tokens[1].kind === 'op' && tokens[1].value === '=') {
    const target = next();
    next(); // '='
    const value = parseExpr(0);
    node = { type: 'Assign', target: target.value, value, start: target.start, end: value.end };
  } else {
    node = parseExpr(0);
  }

  const tail = peek();
  if (tail.kind === 'rparen') throw parseError('unmatched ")"', tail.start);
  if (tail.kind !== 'eof') throw parseError(`unexpected ${describe(tail)} after expression`, tail.start);
  return node;
}

module.exports = { parseFormula, tokenize };
