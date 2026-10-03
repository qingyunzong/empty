import { RevError, E } from './errors.js';

const BIN_BP = {
  or: 1, and: 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6,
};
const PREFIX_BP = 7;
const ATTR_BP = 8;

export function parse(tokens) {
  let pos = 0;
  const peek = (k = 0) => tokens[pos + k];
  const next = () => tokens[pos++];
  const at = (type, value) => {
    const t = peek();
    return t && t.type === type && (value === undefined || t.value === value);
  };
  const describe = (t) => (t.type === 'eof' ? 'end of input' : `'${t.value}'`);
  const expect = (type, value, what) => {
    const t = peek();
    if (!at(type, value)) {
      throw new RevError(E.PARSE, `expected ${what ?? value ?? type} but found ${describe(t)} (line ${t.line})`);
    }
    return next();
  };

  function parseProgram() {
    const body = [];
    while (!at('eof')) body.push(parseStmt());
    return { kind: 'Program', body };
  }

  function parseBlock() {
    expect('punct', '{');
    const body = [];
    while (!at('punct', '}')) body.push(parseStmt());
    expect('punct', '}');
    return body;
  }

  function parseStmt() {
    const t = peek();
    if (t.type === 'kw') {
      switch (t.value) {
        case 'param': return parseParam();
        case 'let': return parseLet();
        case 'for': return parseFor();
        case 'if': return parseIf();
        case 'reverse': {
          next();
          const target = parseExpr(0);
          expect('punct', ';');
          return { kind: 'Reverse', target, line: t.line };
        }
        case 'cancel': {
          next();
          const target = parseExpr(0);
          expect('punct', ';');
          return { kind: 'Cancel', target, line: t.line };
        }
        case 'move': return parseMove();
        default: break;
      }
    }
    throw new RevError(E.PARSE, `unexpected ${describe(t)} (line ${t.line})`);
  }

  function parseParam() {
    next();
    const name = expect('ident', undefined, 'param name').value;
    expect('punct', '=');
    const t = next();
    let value;
    if (t.type === 'number') value = { kind: 'Num', value: t.value, isMoney: t.isMoney };
    else if (t.type === 'string') value = { kind: 'Str', value: t.value };
    else if (t.type === 'kw' && (t.value === 'true' || t.value === 'false')) {
      value = { kind: 'Bool', value: t.value === 'true' };
    } else {
      throw new RevError(E.PARSE, `param value must be a literal (line ${t.line})`);
    }
    expect('punct', ';');
    return { kind: 'Param', name, value };
  }

  function parseLet() {
    next();
    const name = expect('ident', undefined, 'variable name').value;
    expect('punct', '=');
    const expr = parseExpr(0);
    expect('punct', ';');
    return { kind: 'Let', name, expr };
  }

  function parseFor() {
    next();
    const varName = expect('ident', undefined, 'loop variable').value;
    expect('kw', 'in');
    const iterable = parseExpr(0);
    const body = parseBlock();
    return { kind: 'For', varName, iterable, body };
  }

  function parseIf() {
    next();
    const cond = parseExpr(0);
    const then = parseBlock();
    let elseBody = null;
    if (at('kw', 'else')) {
      next();
      elseBody = at('kw', 'if') ? [parseIf()] : parseBlock();
    }
    return { kind: 'If', cond, then, else: elseBody };
  }

  function parseMove() {
    next();
    const amount = parseExpr(0);
    expect('kw', 'from');
    const from = expect('account', undefined, 'source account (acc:...)').value;
    expect('kw', 'to');
    const to = expect('account', undefined, 'target account (acc:...)').value;
    expect('punct', ';');
    return { kind: 'Move', amount, from, to };
  }

  function parseExpr(minBp) {
    let lhs = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && t.value === '.') {
        if (ATTR_BP < minBp) break;
        next();
        const attr = expect('ident', undefined, 'attribute name');
        lhs = { kind: 'Attr', obj: lhs, name: attr.value };
        continue;
      }
      let op = null;
      if (t.type === 'kw' && (t.value === 'and' || t.value === 'or')) op = t.value;
      else if (t.type === 'op') op = t.value;
      else if (t.type === 'punct' && ['+', '-', '*', '<', '>'].includes(t.value)) op = t.value;
      if (op === null || (BIN_BP[op] ?? -1) < minBp) break;
      next();
      const rhs = parseExpr(BIN_BP[op] + 1);
      lhs = { kind: 'Bin', op, lhs, rhs };
    }
    return lhs;
  }

  function parsePrefix() {
    const t = peek();
    if (t.type === 'kw' && t.value === 'not') {
      next();
      return { kind: 'Unary', op: 'not', expr: parseExpr(PREFIX_BP) };
    }
    if (t.type === 'punct' && t.value === '-') {
      next();
      return { kind: 'Unary', op: '-', expr: parseExpr(PREFIX_BP) };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = next();
    switch (t.type) {
      case 'number': return { kind: 'Num', value: t.value, isMoney: t.isMoney };
      case 'string': return { kind: 'Str', value: t.value };
      case 'status': return { kind: 'Status', value: t.value };
      case 'txn': return { kind: 'Txn', id: t.value };
      case 'account': return { kind: 'Account', name: t.value };
      case 'ident': return { kind: 'Var', name: t.value, line: t.line };
      case 'kw':
        if (t.value === 'true' || t.value === 'false') {
          return { kind: 'Bool', value: t.value === 'true' };
        }
        break;
      case 'punct':
        if (t.value === '(') {
          const e = parseExpr(0);
          expect('punct', ')');
          return e;
        }
        if (t.value === '[') {
          const elements = [];
          if (!at('punct', ']')) {
            do { elements.push(parseExpr(0)); } while (at('punct', ',') && next());
          }
          expect('punct', ']');
          return { kind: 'List', elements };
        }
        break;
      default: break;
    }
    throw new RevError(E.PARSE, `unexpected ${describe(t)} (line ${t.line})`);
  }

  return parseProgram();
}
