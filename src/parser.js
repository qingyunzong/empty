'use strict';

const { DslError } = require('./errors');

const INFIX_BP = new Map([
  ['or', 1],
  ['and', 2],
  ['==', 3], ['!=', 3],
  ['<', 4], ['<=', 4], ['>', 4], ['>=', 4],
  ['+', 5], ['-', 5],
  ['*', 6],
]);
const PREFIX_BP = 7;

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const err = (msg, tk) => { throw new DslError('E_PARSE', msg, tk.line, tk.col); };
  const expect = (t) => {
    const tk = next();
    if (tk.t !== t) err(`expected '${t}' but found '${tk.v || tk.t}'`, tk);
    return tk;
  };

  function parseExpr(minBp) {
    const tk = next();
    let left;
    switch (tk.t) {
      case 'MONEY':
        left = { kind: 'money', text: tk.v, line: tk.line, col: tk.col };
        break;
      case 'RATE':
        left = { kind: 'rate', text: tk.v, line: tk.line, col: tk.col };
        break;
      case 'DATE':
        left = { kind: 'date', text: tk.v, line: tk.line, col: tk.col };
        break;
      case 'true':
        left = { kind: 'bool', value: true, line: tk.line, col: tk.col };
        break;
      case 'false':
        left = { kind: 'bool', value: false, line: tk.line, col: tk.col };
        break;
      case 'IDENT': {
        if (peek().t === '(') {
          next();
          const args = [];
          if (peek().t !== ')') {
            args.push(parseExpr(0));
            while (peek().t === ',') { next(); args.push(parseExpr(0)); }
          }
          expect(')');
          left = { kind: 'call', name: tk.v, args, line: tk.line, col: tk.col };
        } else {
          left = { kind: 'name', name: tk.v, line: tk.line, col: tk.col };
        }
        break;
      }
      case 'round': {
        expect('(');
        const arg = parseExpr(0);
        expect(')');
        left = { kind: 'call', name: 'round', args: [arg], line: tk.line, col: tk.col };
        break;
      }
      case '(': {
        left = parseExpr(0);
        expect(')');
        break;
      }
      case '-':
        left = { kind: 'unary', op: '-', expr: parseExpr(PREFIX_BP), line: tk.line, col: tk.col };
        break;
      case 'not':
        left = { kind: 'unary', op: 'not', expr: parseExpr(PREFIX_BP), line: tk.line, col: tk.col };
        break;
      case 'if': {
        const cond = parseExpr(0);
        expect('then');
        const thenBranch = parseExpr(0);
        expect('else');
        const elseBranch = parseExpr(0);
        left = { kind: 'if', cond, then: thenBranch, else: elseBranch, line: tk.line, col: tk.col };
        break;
      }
      default:
        err(`unexpected token '${tk.v || tk.t}'`, tk);
    }
    for (;;) {
      const op = peek();
      const bp = INFIX_BP.get(op.t);
      if (bp === undefined || bp < minBp) return left;
      next();
      const right = parseExpr(bp + 1);
      left = { kind: 'binary', op: op.t, l: left, r: right, line: op.line, col: op.col };
    }
  }

  function parseType() {
    return expect('TYPE').v;
  }

  function parseLet() {
    const kw = expect('let');
    const name = expect('IDENT');
    expect(':');
    const type = parseType();
    expect('=');
    const expr = parseExpr(0);
    expect(';');
    return { name: name.v, type, expr, line: kw.line, col: kw.col };
  }

  function parseParam() {
    const name = expect('IDENT');
    expect(':');
    const type = parseType();
    return { name: name.v, type, line: name.line, col: name.col };
  }

  function parseRule() {
    const kw = expect('rule');
    const name = expect('IDENT');
    expect('(');
    const params = [];
    if (peek().t !== ')') {
      params.push(parseParam());
      while (peek().t === ',') { next(); params.push(parseParam()); }
    }
    expect(')');
    expect('->');
    const retType = parseType();
    expect('{');
    const lets = [];
    while (peek().t === 'let') lets.push(parseLet());
    expect('return');
    const ret = parseExpr(0);
    expect(';');
    expect('}');
    return { name: name.v, params, retType, lets, ret, line: kw.line, col: kw.col };
  }

  const lets = [];
  const rules = [];
  while (peek().t !== 'EOF') {
    if (peek().t === 'let') lets.push(parseLet());
    else if (peek().t === 'rule') rules.push(parseRule());
    else err(`unexpected token '${peek().v || peek().t}'`, peek());
  }
  return { lets, rules };
}

module.exports = { parse };
