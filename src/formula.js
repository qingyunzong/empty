'use strict';

class FormulaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormulaError';
    this.code = 'E_FORMULA';
  }
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      let j = i;
      let seenDot = false;
      while (j < src.length && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) {
        if (src[j] === '.') {
          if (seenDot) break;
          seenDot = true;
        }
        j += 1;
      }
      const text = src.slice(i, j);
      if (!/^(\d+(\.\d+)?|\.\d+)$/.test(text)) {
        throw new FormulaError(`invalid number literal: ${text}`);
      }
      tokens.push({ type: 'num', value: Number(text) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push({ type: 'ident', name: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/()'.includes(ch)) {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    throw new FormulaError(`unexpected character: ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// Grammar:
//   expr   := term (('+'|'-') term)*
//   term   := factor (('*'|'/') factor)*
//   factor := number | ident | '(' expr ')' | ('-'|'+') factor
function parse(src) {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new FormulaError('formula must be a non-empty string');
  }
  const tokens = tokenize(src);
  let pos = 0;

  function peek() { return tokens[pos]; }
  function expect(type) {
    const tok = tokens[pos];
    if (!tok || tok.type !== type) {
      throw new FormulaError(`expected ${JSON.stringify(type)} at token ${pos}`);
    }
    pos += 1;
    return tok;
  }

  function parseExpr() {
    let node = parseTerm();
    while (peek() && (peek().type === '+' || peek().type === '-')) {
      const op = tokens[pos].type;
      pos += 1;
      node = { kind: 'bin', op, left: node, right: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseFactor();
    while (peek() && (peek().type === '*' || peek().type === '/')) {
      const op = tokens[pos].type;
      pos += 1;
      node = { kind: 'bin', op, left: node, right: parseFactor() };
    }
    return node;
  }

  function parseFactor() {
    const tok = peek();
    if (!tok) throw new FormulaError('unexpected end of formula');
    if (tok.type === '-' || tok.type === '+') {
      pos += 1;
      const operand = parseFactor();
      return tok.type === '-' ? { kind: 'neg', operand } : operand;
    }
    if (tok.type === 'num') {
      pos += 1;
      return { kind: 'num', value: tok.value };
    }
    if (tok.type === 'ident') {
      pos += 1;
      return { kind: 'ref', name: tok.name };
    }
    if (tok.type === '(') {
      pos += 1;
      const node = parseExpr();
      expect(')');
      return node;
    }
    throw new FormulaError(`unexpected token: ${JSON.stringify(tok.type)}`);
  }

  const ast = parseExpr();
  if (pos !== tokens.length) {
    throw new FormulaError(`trailing tokens in formula at position ${pos}`);
  }
  return ast;
}

function collectDeps(ast, into = new Set()) {
  switch (ast.kind) {
    case 'num':
      break;
    case 'ref':
      into.add(ast.name);
      break;
    case 'neg':
      collectDeps(ast.operand, into);
      break;
    case 'bin':
      collectDeps(ast.left, into);
      collectDeps(ast.right, into);
      break;
    default:
      throw new FormulaError(`unknown ast node kind: ${ast.kind}`);
  }
  return into;
}

// resolve(name) must return a number for a known, valid dependency.
// Throws FormulaError on division by zero.
function evaluate(ast, resolve) {
  switch (ast.kind) {
    case 'num':
      return ast.value;
    case 'ref':
      return resolve(ast.name);
    case 'neg':
      return -evaluate(ast.operand, resolve);
    case 'bin': {
      const l = evaluate(ast.left, resolve);
      const r = evaluate(ast.right, resolve);
      switch (ast.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new FormulaError('division by zero');
          return l / r;
        default:
          throw new FormulaError(`unknown operator: ${ast.op}`);
      }
      break;
    }
    default:
      throw new FormulaError(`unknown ast node kind: ${ast.kind}`);
  }
}

module.exports = { FormulaError, tokenize, parse, collectDeps, evaluate };
