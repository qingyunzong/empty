// Pratt parser for the rules DSL.
//
// Grammar:
//   program  := ruleDecl*
//   ruleDecl := "rule" IDENT "{" member* "}"
//   member   := opDecl | letDecl | predDecl
//   opDecl   := "op" IDENT "(" params? ")" ("->" type)? ";"
//   letDecl  := "let" IDENT "=" expr ";"
//   predDecl := ("happens-before"|"concurrent"|"commutes")
//               "(" IDENT "," IDENT ")" ":" expr ";"
//   expr     := Pratt over { or, and, not, ==, !=, <, <=, >, >=, .field }

import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message, { file, line, col }) {
    super(message);
    this.name = 'ParseError';
    this.file = file;
    this.line = line;
    this.col = col;
  }
}

const INFIX_BP = {
  'or': 1,
  'and': 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
};

const TYPE_NAMES = new Set(['int', 'string', 'bool']);

export function parseDsl(source, file = '<rules>') {
  const tokens = tokenize(source, file);
  let pos = 0;

  const peek = () => tokens[pos];
  const fail = (tok, msg) => {
    throw new ParseError(msg, { file, line: tok.line, col: tok.col });
  };
  const describe = (t) => (t.type === 'eof' ? 'end of input' : JSON.stringify(t.value));
  const expect = (type, value) => {
    const t = peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      fail(t, `expected ${value !== undefined ? JSON.stringify(value) : type}, got ${describe(t)}`);
    }
    pos += 1;
    return t;
  };
  const accept = (type, value) => {
    const t = peek();
    if (t.type === type && (value === undefined || t.value === value)) { pos += 1; return t; }
    return null;
  };
  const expectName = (what) => {
    const t = peek();
    // Allow keywords "op"/"key" to be reused as identifiers in name positions.
    if (t.type === 'ident' || (t.type === 'keyword' && (t.value === 'op' || t.value === 'key'))) {
      pos += 1;
      return t;
    }
    fail(t, `expected ${what}, got ${describe(t)}`);
    return null;
  };

  function parseType() {
    const t = peek();
    if (t.type === 'keyword' && TYPE_NAMES.has(t.value)) { pos += 1; return t.value; }
    fail(t, `expected a type (int, string or bool), got ${describe(t)}`);
    return null;
  }

  function parseExpr(minBp = 1) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && t.value === '.') {
        pos += 1;
        const f = expectName('field name');
        if (left.kind !== 'var') fail(t, 'field access requires an operation variable');
        left = { kind: 'field', name: left.name, field: f.value, line: t.line, col: t.col };
        continue;
      }
      let op = null;
      if (t.type === 'keyword' && (t.value === 'and' || t.value === 'or')) op = t.value;
      else if (t.type === 'punct' && INFIX_BP[t.value] !== undefined) op = t.value;
      if (op === null || INFIX_BP[op] < minBp) break;
      pos += 1;
      const right = parseExpr(INFIX_BP[op] + 1);
      left = { kind: 'bin', op, left, right, line: t.line, col: t.col };
    }
    return left;
  }

  function parsePrefix() {
    const t = peek();
    if (t.type === 'keyword' && t.value === 'not') {
      pos += 1;
      return { kind: 'not', expr: parsePrefix(), line: t.line, col: t.col };
    }
    if (t.type === 'int') { pos += 1; return { kind: 'lit', vtype: 'int', value: t.value, line: t.line, col: t.col }; }
    if (t.type === 'string') { pos += 1; return { kind: 'lit', vtype: 'string', value: t.value, line: t.line, col: t.col }; }
    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      pos += 1;
      return { kind: 'lit', vtype: 'bool', value: t.value === 'true', line: t.line, col: t.col };
    }
    if (t.type === 'keyword' && t.value === 'null') {
      pos += 1;
      return { kind: 'lit', vtype: 'null', value: null, line: t.line, col: t.col };
    }
    if (t.type === 'opPattern' || t.type === 'keyPattern') {
      pos += 1;
      return { kind: 'pat', ptype: t.type === 'opPattern' ? 'op' : 'key', value: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'ident') { pos += 1; return { kind: 'var', name: t.value, line: t.line, col: t.col }; }
    if (t.type === 'punct' && t.value === '(') {
      pos += 1;
      const e = parseExpr(1);
      expect('punct', ')');
      return e;
    }
    fail(t, `unexpected ${describe(t)} in expression`);
    return null;
  }

  function parseOpDecl() {
    const kw = expect('keyword', 'op');
    const name = expectName('operation name');
    expect('punct', '(');
    const params = [];
    if (!accept('punct', ')')) {
      do {
        const pName = expectName('parameter name');
        expect('punct', ':');
        const pType = parseType();
        params.push({ name: pName.value, type: pType, line: pName.line, col: pName.col });
      } while (accept('punct', ','));
      expect('punct', ')');
    }
    let result = null;
    if (accept('punct', '->')) result = parseType();
    expect('punct', ';');
    return { kind: 'opDecl', name: name.value, params, result, line: kw.line, col: kw.col };
  }

  function parseLetDecl() {
    const kw = expect('keyword', 'let');
    const name = expect('ident');
    expect('punct', '=');
    const expr = parseExpr(1);
    expect('punct', ';');
    return { kind: 'letDecl', name: name.value, expr, line: kw.line, col: kw.col };
  }

  function parsePredDecl(kindName) {
    const kw = expect('keyword', kindName);
    expect('punct', '(');
    const x = expect('ident');
    expect('punct', ',');
    const y = expect('ident');
    expect('punct', ')');
    expect('punct', ':');
    const expr = parseExpr(1);
    expect('punct', ';');
    return { kind: 'predDecl', pred: kindName, binders: [x.value, y.value], expr, line: kw.line, col: kw.col };
  }

  function parseRule() {
    const kw = expect('keyword', 'rule');
    const name = expect('ident');
    expect('punct', '{');
    const members = [];
    for (;;) {
      const t = peek();
      if (t.type === 'punct' && t.value === '}') { pos += 1; break; }
      if (t.type === 'eof') fail(t, `unterminated rule block ${JSON.stringify(name.value)}`);
      if (t.type === 'keyword' && t.value === 'op') members.push(parseOpDecl());
      else if (t.type === 'keyword' && t.value === 'let') members.push(parseLetDecl());
      else if (t.type === 'keyword' && (t.value === 'happens-before' || t.value === 'concurrent' || t.value === 'commutes')) {
        members.push(parsePredDecl(t.value));
      } else {
        fail(t, `unexpected ${describe(t)} in rule block`);
      }
    }
    return { name: name.value, members, line: kw.line, col: kw.col };
  }

  const rules = [];
  while (peek().type !== 'eof') rules.push(parseRule());
  if (rules.length === 0) fail(peek(), 'expected at least one rule block');
  return { rules, file };
}
