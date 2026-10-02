// Safe interlock expression parser/evaluator (no eval()).
// Grammar:
//   or      := and ('||' and)*
//   and     := cmp ('&&' cmp)*
//   cmp     := add (('=='|'!='|'<'|'<='|'>'|'>=') add)?
//   add     := mul (('+'|'-') mul)*
//   mul     := unary (('*'|'/'|'%') unary)*
//   unary   := '!' unary | '-' unary | primary
//   primary := number | string | 'true' | 'false' | ident | '(' or ')'

import { ValidationError } from './errors.js';

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_.]*)|(\|\||&&|==|!=|<=|>=|[<>!+\-*/%()]))/y;

function tokenize(src) {
  const tokens = [];
  let pos = 0;
  while (pos < src.length) {
    if (/\s/.test(src[pos])) { pos += 1; continue; }
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m || m.index !== pos) {
      throw new ValidationError(`interlock: unexpected character at ${pos}`, { src });
    }
    pos = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'str', v: JSON.parse(m[2].startsWith("'") ? `"${m[2].slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"` : m[2]) });
    else if (m[3] !== undefined) tokens.push({ t: 'ident', v: m[3] });
    else tokens.push({ t: 'op', v: m[4] });
  }
  tokens.push({ t: 'eof', v: null });
  return tokens;
}

class Parser {
  constructor(tokens) { this.tokens = tokens; this.i = 0; }
  peek() { return this.tokens[this.i]; }
  next() { return this.tokens[this.i++]; }
  expectOp(v) {
    const tok = this.next();
    if (tok.t !== 'op' || tok.v !== v) {
      throw new ValidationError(`interlock: expected '${v}'`, { got: tok });
    }
  }
  parseOr() {
    let left = this.parseAnd();
    while (this.peek().t === 'op' && this.peek().v === '||') {
      this.next();
      left = { op: '||', l: left, r: this.parseAnd() };
    }
    return left;
  }
  parseAnd() {
    let left = this.parseCmp();
    while (this.peek().t === 'op' && this.peek().v === '&&') {
      this.next();
      left = { op: '&&', l: left, r: this.parseCmp() };
    }
    return left;
  }
  parseCmp() {
    const left = this.parseAdd();
    const tok = this.peek();
    if (tok.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(tok.v)) {
      this.next();
      return { op: tok.v, l: left, r: this.parseAdd() };
    }
    return left;
  }
  parseAdd() {
    let left = this.parseMul();
    while (this.peek().t === 'op' && (this.peek().v === '+' || this.peek().v === '-')) {
      const op = this.next().v;
      left = { op, l: left, r: this.parseMul() };
    }
    return left;
  }
  parseMul() {
    let left = this.parseUnary();
    while (this.peek().t === 'op' && ['*', '/', '%'].includes(this.peek().v)) {
      const op = this.next().v;
      left = { op, l: left, r: this.parseUnary() };
    }
    return left;
  }
  parseUnary() {
    const tok = this.peek();
    if (tok.t === 'op' && tok.v === '!') { this.next(); return { op: '!', x: this.parseUnary() }; }
    if (tok.t === 'op' && tok.v === '-') { this.next(); return { op: 'neg', x: this.parseUnary() }; }
    return this.parsePrimary();
  }
  parsePrimary() {
    const tok = this.next();
    if (tok.t === 'num') return { op: 'lit', v: tok.v };
    if (tok.t === 'str') return { op: 'lit', v: tok.v };
    if (tok.t === 'ident') {
      if (tok.v === 'true') return { op: 'lit', v: true };
      if (tok.v === 'false') return { op: 'lit', v: false };
      return { op: 'ref', key: tok.v };
    }
    if (tok.t === 'op' && tok.v === '(') {
      const e = this.parseOr();
      this.expectOp(')');
      return e;
    }
    throw new ValidationError('interlock: unexpected token', { got: tok });
  }
}

export function parseExpression(src) {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new ValidationError('interlock: expression must be a non-empty string');
  }
  const parser = new Parser(tokenize(src));
  const ast = parser.parseOr();
  if (parser.peek().t !== 'eof') {
    throw new ValidationError('interlock: trailing tokens', { at: parser.peek() });
  }
  return ast;
}

function evalAst(node, env) {
  switch (node.op) {
    case 'lit': return node.v;
    case 'ref': {
      if (!(node.key in env)) {
        throw new ValidationError(`interlock: unknown key '${node.key}'`);
      }
      return env[node.key];
    }
    case '!': return !truthy(evalAst(node.x, env));
    case 'neg': {
      const v = evalAst(node.x, env);
      if (typeof v !== 'number') throw new ValidationError('interlock: unary - on non-number');
      return -v;
    }
    case '&&': return truthy(evalAst(node.l, env)) && truthy(evalAst(node.r, env));
    case '||': return truthy(evalAst(node.l, env)) || truthy(evalAst(node.r, env));
    case '==': return evalAst(node.l, env) === evalAst(node.r, env);
    case '!=': return evalAst(node.l, env) !== evalAst(node.r, env);
    case '<': return evalAst(node.l, env) < evalAst(node.r, env);
    case '<=': return evalAst(node.l, env) <= evalAst(node.r, env);
    case '>': return evalAst(node.l, env) > evalAst(node.r, env);
    case '>=': return evalAst(node.l, env) >= evalAst(node.r, env);
    case '+': case '-': case '*': case '/': case '%': {
      const a = evalAst(node.l, env);
      const b = evalAst(node.r, env);
      if (typeof a !== 'number' || typeof b !== 'number') {
        throw new ValidationError(`interlock: '${node.op}' requires numbers`);
      }
      if (node.op === '+') return a + b;
      if (node.op === '-') return a - b;
      if (node.op === '*') return a * b;
      if (node.op === '/') return a / b;
      return a % b;
    }
    default:
      throw new ValidationError(`interlock: unknown op '${node.op}'`);
  }
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  throw new ValidationError('interlock: expected boolean operand', { got: v });
}

export function evaluate(ast, env) {
  return evalAst(ast, env);
}

// Collect all parameter keys referenced by an expression.
export function referencedKeys(ast, acc = new Set()) {
  if (!node_is(ast)) return acc;
  if (ast.op === 'ref') acc.add(ast.key);
  for (const k of ['l', 'r', 'x']) if (ast[k]) referencedKeys(ast[k], acc);
  return acc;
}
function node_is(x) { return x && typeof x === 'object'; }
