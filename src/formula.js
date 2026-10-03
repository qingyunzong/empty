'use strict';

class FormulaSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormulaSyntaxError';
    this.code = 'FORMULA_SYNTAX';
  }
}

class DivisionByZeroError extends Error {
  constructor() {
    super('division by zero');
    this.name = 'DivisionByZeroError';
    this.code = 'DIVISION_BY_ZERO';
  }
}

class UnknownReferenceError extends Error {
  constructor(name) {
    super(`unknown tag reference: ${name}`);
    this.name = 'UnknownReferenceError';
    this.code = 'UNKNOWN_REFERENCE';
    this.tag = name;
  }
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch) {
  return isIdentStart(ch) || isDigit(ch) || ch === '.';
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] || ''))) {
      let j = i;
      let seenDot = false;
      while (j < src.length) {
        const c = src[j];
        if (isDigit(c)) j += 1;
        else if (c === '.' && !seenDot) {
          seenDot = true;
          j += 1;
        } else break;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (k < src.length && isDigit(src[k])) {
          while (k < src.length && isDigit(src[k])) k += 1;
          j = k;
        }
      }
      const text = src.slice(i, j);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new FormulaSyntaxError(`invalid number literal: ${text}`);
      tokens.push({ type: 'number', value });
      i = j;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < src.length && isIdentPart(src[j])) j += 1;
      tokens.push({ type: 'ident', name: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', op: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen' });
      i += 1;
      continue;
    }
    throw new FormulaSyntaxError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

function parse(src) {
  if (typeof src !== 'string') throw new FormulaSyntaxError('formula must be a string');
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];

  function parseExpr() {
    let node = parseTerm();
    while (peek().type === 'op' && (peek().op === '+' || peek().op === '-')) {
      const op = tokens[pos].op;
      pos += 1;
      node = { type: 'binary', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseFactor();
    while (peek().type === 'op' && (peek().op === '*' || peek().op === '/')) {
      const op = tokens[pos].op;
      pos += 1;
      node = { type: 'binary', op, left: node, right: parseFactor() };
    }
    return node;
  }

  function parseFactor() {
    const t = peek();
    if (t.type === 'op' && (t.op === '-' || t.op === '+')) {
      pos += 1;
      const operand = parseFactor();
      return t.op === '-' ? { type: 'negate', operand } : operand;
    }
    if (t.type === 'number') {
      pos += 1;
      return { type: 'number', value: t.value };
    }
    if (t.type === 'ident') {
      pos += 1;
      return { type: 'ref', name: t.name };
    }
    if (t.type === 'lparen') {
      pos += 1;
      const node = parseExpr();
      if (peek().type !== 'rparen') throw new FormulaSyntaxError('missing closing parenthesis');
      pos += 1;
      return node;
    }
    throw new FormulaSyntaxError(`unexpected token at offset ${pos}`);
  }

  const ast = parseExpr();
  if (peek().type !== 'eof') throw new FormulaSyntaxError('unexpected trailing tokens');
  return ast;
}

function extractDeps(ast) {
  const deps = new Set();
  (function walk(node) {
    if (node.type === 'ref') deps.add(node.name);
    else if (node.type === 'binary') {
      walk(node.left);
      walk(node.right);
    } else if (node.type === 'negate') walk(node.operand);
  })(ast);
  return deps;
}

function evaluate(ast, resolve) {
  switch (ast.type) {
    case 'number':
      return ast.value;
    case 'negate':
      return -evaluate(ast.operand, resolve);
    case 'ref': {
      const v = resolve(ast.name);
      if (v === undefined || v === null || typeof v !== 'number') throw new UnknownReferenceError(ast.name);
      return v;
    }
    case 'binary': {
      const l = evaluate(ast.left, resolve);
      const r = evaluate(ast.right, resolve);
      switch (ast.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) throw new DivisionByZeroError();
          return l / r;
        default:
          throw new FormulaSyntaxError(`unknown operator ${ast.op}`);
      }
    }
    default:
      throw new FormulaSyntaxError(`unknown node type ${ast.type}`);
  }
}

module.exports = {
  parse,
  evaluate,
  extractDeps,
  tokenize,
  FormulaSyntaxError,
  DivisionByZeroError,
  UnknownReferenceError,
};
