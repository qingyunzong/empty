import { parseError } from './errors.js';

// Pratt parser. Precedence (low -> high):
//   or < and < == != < < <= > >= < + - < * / < unary(-, not) < call
const INFIX_BP = {
  'or': 1,
  'and': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
};
const UNARY_BP = 7;
const TYPE_NAMES = new Set(['money', 'rate', 'date', 'bool']);

export function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const advance = () => tokens[pos++];
  const expect = (type) => {
    const tok = advance();
    if (tok.type !== type) {
      throw parseError(`expected '${type}' but found '${tok.type}'`, tok.line, tok.col);
    }
    return tok;
  };

  function parseTypeName() {
    const tok = advance();
    if (!TYPE_NAMES.has(tok.type)) {
      throw parseError(`expected a type (money/rate/date/bool) but found '${tok.type}'`, tok.line, tok.col);
    }
    return tok.type;
  }

  function parseProgram() {
    const decls = [];
    while (peek().type !== 'eof') decls.push(parseDecl());
    return { type: 'program', decls };
  }

  function parseDecl() {
    const tok = peek();
    if (tok.type === 'rule') return parseRuleDecl();
    if (tok.type === 'param' || tok.type === 'let') return parseLetLike();
    throw parseError(`expected 'param', 'let' or 'rule' but found '${tok.type}'`, tok.line, tok.col);
  }

  function parseLetLike() {
    const kw = advance(); // 'param' | 'let'
    const name = expect('ident');
    expect(':');
    const declaredType = parseTypeName();
    expect('=');
    const expr = parseExpr(0);
    return {
      type: kw.type === 'param' ? 'paramDecl' : 'letDecl',
      name: name.value, declaredType, expr,
      line: kw.line, col: kw.col, start: kw.off, end: expr.end,
    };
  }

  function parseRuleDecl() {
    const kw = expect('rule');
    const name = expect('ident');
    expect('(');
    const params = [];
    if (peek().type !== ')') {
      for (;;) {
        const p = expect('ident');
        expect(':');
        params.push({ name: p.value, type: parseTypeName(), line: p.line, col: p.col });
        if (peek().type !== ',') break;
        advance();
      }
    }
    expect(')');
    expect('->');
    const returnType = parseTypeName();
    const body = parseBlock();
    return {
      type: 'ruleDecl', name: name.value, params, returnType, body,
      line: kw.line, col: kw.col, start: kw.off, end: body.end,
    };
  }

  function parseBlock() {
    expect('{');
    const lets = [];
    while (peek().type === 'let') lets.push(parseLetLike());
    const expr = parseExpr(0);
    const close = expect('}');
    return { type: 'block', lets, expr, end: close.end };
  }

  function parseExpr(minBp) {
    let left = parsePrefix();
    for (;;) {
      const tok = peek();
      const bp = INFIX_BP[tok.type];
      if (bp === undefined || bp <= minBp) return left;
      advance();
      const right = parseExpr(bp);
      left = { type: 'binary', op: tok.type, left, right, line: tok.line, col: tok.col, end: right.end };
    }
  }

  function parsePrefix() {
    const tok = advance();
    switch (tok.type) {
      case 'money': return { type: 'moneyLit', value: tok.value, line: tok.line, col: tok.col, end: tok.end };
      case 'rate': return { type: 'rateLit', value: tok.value, line: tok.line, col: tok.col, end: tok.end };
      case 'date': return { type: 'dateLit', value: tok.value, line: tok.line, col: tok.col, end: tok.end };
      case 'true': return { type: 'boolLit', value: true, line: tok.line, col: tok.col, end: tok.end };
      case 'false': return { type: 'boolLit', value: false, line: tok.line, col: tok.col, end: tok.end };
      case '(': {
        const inner = parseExpr(0);
        expect(')');
        return inner;
      }
      case '-': {
        const operand = parseExpr(UNARY_BP);
        return { type: 'unary', op: '-', operand, line: tok.line, col: tok.col, end: operand.end };
      }
      case 'not': {
        const operand = parseExpr(UNARY_BP);
        return { type: 'unary', op: 'not', operand, line: tok.line, col: tok.col, end: operand.end };
      }
      case 'if': {
        const cond = parseExpr(0);
        const thenBlock = parseBlock();
        expect('else');
        const elseBlock = parseBlock();
        return { type: 'if', cond, thenBlock, elseBlock, line: tok.line, col: tok.col, end: elseBlock.end };
      }
      case 'ident': {
        if (peek().type === '(') {
          advance();
          const args = [];
          if (peek().type !== ')') {
            for (;;) {
              args.push(parseExpr(0));
              if (peek().type !== ',') break;
              advance();
            }
          }
          const close = expect(')');
          return { type: 'call', name: tok.value, args, line: tok.line, col: tok.col, end: close.end };
        }
        return { type: 'var', name: tok.value, line: tok.line, col: tok.col, end: tok.end };
      }
      default:
        throw parseError(`unexpected token '${tok.type}'`, tok.line, tok.col);
    }
  }

  return parseProgram();
}
