'use strict';

const { tokenize } = require('./lexer');
const { ParseError } = require('./errors');

// Binding powers: or < and (incl. implicit and) < not < primary.
const OR_BP = [1, 2];
const AND_BP = [3, 4];
const NOT_BP = 5;

function parse(input) {
  const tokens = typeof input === 'string' ? tokenize(input) : input;
  let pos = 0;

  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];

  const startsPrefix = (t) =>
    t.type === 'NOT' || t.type === 'LPAREN' || t.type === 'WORD' ||
    t.type === 'PHRASE' || t.type === 'REGEX';

  function parseValue() {
    const t = advance();
    if (t.type === 'WORD') return { kind: 'word', value: t.value };
    if (t.type === 'PHRASE') return { kind: 'phrase', value: t.value };
    if (t.type === 'REGEX') return { kind: 'regex', value: t.value, flags: t.flags || '' };
    throw new ParseError(`Expected a value (word, phrase or regex) but found ${t.type}`);
  }

  function parsePrefix() {
    const t = advance();
    switch (t.type) {
      case 'NOT':
        return { type: 'not', child: parseExpr(NOT_BP) };
      case 'LPAREN': {
        const inner = parseExpr(0);
        const closing = advance();
        if (closing.type !== 'RPAREN') {
          throw new ParseError(`Expected ')' but found ${closing.type}`);
        }
        return inner;
      }
      case 'WORD': {
        const la = peek();
        if (la.type === 'COLON') {
          advance();
          return { type: 'match', field: t.value, value: parseValue() };
        }
        if (la.type === 'OP') {
          advance();
          return { type: 'cmp', field: t.value, op: la.value, value: parseValue() };
        }
        return { type: 'text', value: { kind: 'word', value: t.value } };
      }
      case 'PHRASE':
        return { type: 'text', value: { kind: 'phrase', value: t.value } };
      case 'REGEX':
        return { type: 'text', value: { kind: 'regex', value: t.value, flags: t.flags || '' } };
      default:
        throw new ParseError(`Unexpected token ${t.type}`);
    }
  }

  function parseExpr(minBp) {
    let lhs = parsePrefix();
    for (;;) {
      const t = peek();
      let op;
      let bp;
      let explicit = true;
      if (t.type === 'OR') {
        op = 'or';
        bp = OR_BP;
      } else if (t.type === 'AND') {
        op = 'and';
        bp = AND_BP;
      } else if (startsPrefix(t)) {
        // Juxtaposition binds as an implicit AND.
        op = 'and';
        bp = AND_BP;
        explicit = false;
      } else {
        break;
      }
      if (bp[0] < minBp) break;
      if (explicit) advance();
      const rhs = parseExpr(bp[1]);
      lhs = { type: op, children: [lhs, rhs] };
    }
    return lhs;
  }

  const ast = parseExpr(0);
  if (peek().type !== 'EOF') {
    throw new ParseError(`Unexpected trailing token ${peek().type}`);
  }
  return ast;
}

module.exports = { parse };
