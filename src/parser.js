import { tokenize } from './lexer.js';
import { E } from './errors.js';

// Pratt parser. Expression grammar (amounts and balance conditions):
//   expr := equality
//   equality := additive ('==' additive)?
//   additive := multiplicative (('+'|'-') multiplicative)*
//   multiplicative := unary (('*'|'/') unary)*
//   unary := '-' unary | primary
//   primary := NUMBER | VPARAM | 'debit' | 'credit' | '(' expr ')'
// 'debit'/'credit' primaries (running totals) are only legal inside `balance`.

const BINDING_POWER = { '==': 1, '+': 2, '-': 2, '*': 3, '/': 3 };

export function parse(src) {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expect = (type) => {
    const t = next();
    if (t.type !== type) throw E.parse(`expected '${type}', got '${t.type}' at line ${t.line}`);
    return t;
  };

  function parsePrefix(inBalance) {
    const t = next();
    if (t.type === 'NUMBER') return { kind: 'num', value: t.value, line: t.line };
    if (t.type === 'VPARAM') return { kind: 'param', name: t.value, line: t.line };
    if (t.type === 'DEBIT' || t.type === 'CREDIT') {
      if (!inBalance) throw E.parse(`'${t.value}' total is only allowed in a balance condition (line ${t.line})`);
      return { kind: 'total', side: t.value, line: t.line };
    }
    if (t.type === '-') {
      const operand = parsePrefix(inBalance);
      return { kind: 'bin', op: '-', left: { kind: 'num', value: 0, line: t.line }, right: operand, line: t.line };
    }
    if (t.type === '(') {
      const inner = parseExpr(0, inBalance);
      expect(')');
      return inner;
    }
    throw E.parse(`unexpected token '${t.type}' at line ${t.line}`);
  }

  function parseExpr(minBp, inBalance) {
    let left = parsePrefix(inBalance);
    for (;;) {
      const t = peek();
      const op = t.type === 'EQEQ' ? '==' : t.type;
      const bp = BINDING_POWER[op];
      if (bp === undefined || bp < minBp) return left;
      next();
      const right = parseExpr(bp + 1, inBalance);
      left = { kind: 'bin', op, left, right, line: t.line };
    }
  }

  function parseTemplate() {
    const name = expect('IDENT').value;
    expect('(');
    const params = [];
    if (peek().type !== ')') {
      for (;;) {
        params.push(expect('IDENT').value);
        if (peek().type !== ',') break;
        next();
      }
    }
    expect(')');
    expect('{');
    const body = [];
    while (peek().type !== '}') {
      const t = next();
      if (t.type === 'DEBIT' || t.type === 'CREDIT') {
        const account = expect('IDENT').value;
        const expr = parseExpr(0, false);
        body.push({ type: t.value, account, expr, line: t.line });
      } else if (t.type === 'BALANCE') {
        const expr = parseExpr(0, true);
        body.push({ type: 'balance', expr, line: t.line });
      } else {
        throw E.parse(`unexpected '${t.type}' in template body at line ${t.line}`);
      }
    }
    expect('}');
    return { type: 'template', name, params, body };
  }

  function parseBatch() {
    const name = expect('IDENT').value;
    expect('{');
    expect('PERIOD');
    const period = expect('STRING').value;
    expect('ALLOW');
    const allow = [expect('IDENT').value];
    while (peek().type === ',') {
      next();
      allow.push(expect('IDENT').value);
    }
    expect('}');
    return { type: 'batch', name, period, allow };
  }

  const program = { periods: [], templates: [], batches: [] };
  while (peek().type !== 'EOF') {
    const t = next();
    if (t.type === 'PERIOD') {
      program.periods.push({ name: expect('STRING').value, line: t.line });
    } else if (t.type === 'TEMPLATE') {
      program.templates.push(parseTemplate());
    } else if (t.type === 'BATCH') {
      program.batches.push(parseBatch());
    } else {
      throw E.parse(`unexpected '${t.type}' at top level, line ${t.line}`);
    }
  }
  return program;
}
