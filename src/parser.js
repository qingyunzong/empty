'use strict';

const { QuerySyntaxError } = require('./errors');

const PRECEDENCE = { OR: 1, AND: 2 };

function peek(state) {
  return state.tokens[state.pos];
}

function next(state) {
  return state.tokens[state.pos++];
}

function expect(state, type) {
  const tok = next(state);
  if (tok.type !== type) {
    throw new QuerySyntaxError(
      `expected ${type} but found ${tok.type} at position ${tok.pos}`
    );
  }
  return tok;
}

function parseValue(state) {
  const tok = next(state);
  if (tok.type === 'WORD' || tok.type === 'PHRASE') {
    return { value: tok.value, quoted: tok.type === 'PHRASE' };
  }
  throw new QuerySyntaxError(
    `expected a value but found ${tok.type} at position ${tok.pos}`
  );
}

function parseFieldPredicate(state, field) {
  const tok = next(state);
  if (tok.type === 'WORD') {
    return { type: 'field', field, value: tok.value, match: 'word' };
  }
  if (tok.type === 'PHRASE') {
    return { type: 'field', field, value: tok.value, match: 'phrase' };
  }
  if (tok.type === 'REGEX') {
    return { type: 'field', field, value: tok.value, flags: tok.flags, match: 'regex' };
  }
  throw new QuerySyntaxError(
    `expected a value after '${field}:' but found ${tok.type} at position ${tok.pos}`
  );
}

function parseComparison(state, field, op) {
  const value = parseValue(state);
  return { type: 'compare', field, op, value: value.value };
}

function parsePrefix(state) {
  const tok = next(state);
  if (tok.type === 'NOT') {
    return { type: 'not', operand: parsePrefix(state) };
  }
  if (tok.type === 'LPAREN') {
    const expr = parseExpression(state, 0);
    expect(state, 'RPAREN');
    return expr;
  }
  if (tok.type === 'WORD') {
    const nextTok = peek(state);
    if (nextTok.type === 'COLON') {
      next(state);
      return parseFieldPredicate(state, tok.value);
    }
    if (nextTok.type === 'OP') {
      next(state);
      return parseComparison(state, tok.value, nextTok.value);
    }
    return { type: 'fulltext', value: tok.value, match: 'word' };
  }
  if (tok.type === 'PHRASE') {
    return { type: 'fulltext', value: tok.value, match: 'phrase' };
  }
  if (tok.type === 'REGEX') {
    return { type: 'fulltext', value: tok.value, flags: tok.flags, match: 'regex' };
  }
  throw new QuerySyntaxError(
    `unexpected token ${tok.type} at position ${tok.pos}`
  );
}

function parseExpression(state, minPrec) {
  let left = parsePrefix(state);
  while (true) {
    const tok = peek(state);
    if (tok.type !== 'AND' && tok.type !== 'OR') break;
    const prec = PRECEDENCE[tok.type];
    if (prec < minPrec) break;
    next(state);
    const right = parseExpression(state, prec + 1);
    left = { type: 'binary', op: tok.value, left, right };
  }
  return left;
}

function parse(tokens) {
  const state = { tokens, pos: 0 };
  const expr = parseExpression(state, 0);
  expect(state, 'EOF');
  return expr;
}

module.exports = { parse };
