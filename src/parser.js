import { tokenize, DslSyntaxError } from './lexer.js';

// Grammar:
//   program    := letDecl* filter ('|' agg (',' agg)* ('by' IDENT)?)? EOF
//   letDecl    := 'let' IDENT '=' orExpr ';'
//   filter     := orExpr
//   orExpr     := andExpr ('or' andExpr)*
//   andExpr    := notExpr ('and' notExpr)*
//   notExpr    := 'not' notExpr | comparison
//   comparison := primary (cmpOp primary)?        (non-associative)
//   primary    := NUMBER | TIME | STRING | 'true' | 'false'
//               | IDENT | '(' orExpr ')'
//   agg        := 'count' | ('sum'|'avg'|'min'|'max') '(' IDENT ')'

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=', '=~', '!~']);
const AGG_FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max']);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
    this.scope = [new Map()]; // lexical scopes for let-bound names
  }

  peek() { return this.tokens[this.i]; }

  next() { return this.tokens[this.i++]; }

  expect(type, value) {
    const t = this.peek();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new DslSyntaxError(
        `expected ${value !== undefined ? `'${value}'` : type} but got ${t.type === 'EOF' ? 'end of input' : `'${t.value}'`}`,
        t.pos,
      );
    }
    return this.next();
  }

  isKeyword(word) {
    const t = this.peek();
    return t.type === 'KEYWORD' && t.value === word;
  }

  parseProgram() {
    const lets = [];
    while (this.isKeyword('let')) {
      lets.push(this.parseLet(lets.length));
    }
    const filter = this.parseOr();
    let aggs = null;
    let groupBy = null;
    if (this.peek().type === 'PUNCT' && this.peek().value === '|') {
      this.next();
      aggs = [this.parseAgg()];
      while (this.peek().type === 'PUNCT' && this.peek().value === ',') {
        this.next();
        aggs.push(this.parseAgg());
      }
      if (this.isKeyword('by')) {
        this.next();
        groupBy = this.expect('IDENT').value;
      }
    }
    this.expect('EOF');
    return { type: 'program', lets, filter, aggs, groupBy };
  }

  parseLet(index) {
    this.expect('KEYWORD', 'let');
    const nameTok = this.expect('IDENT');
    const name = nameTok.value;
    this.expect('PUNCT', '=');
    // The body is parsed in the enclosing scope: a let can reference any
    // name visible here (lexical scoping), but not itself or later lets.
    const expr = this.parseOr();
    this.expect('PUNCT', ';');
    this.scope[this.scope.length - 1].set(name, index);
    return { type: 'let', name, expr };
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isKeyword('or')) {
      this.next();
      left = { type: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.isKeyword('and')) {
      this.next();
      left = { type: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  parseNot() {
    if (this.isKeyword('not')) {
      this.next();
      return { type: 'not', expr: this.parseNot() };
    }
    return this.parseComparison();
  }

  parseComparison() {
    const left = this.parsePrimary();
    const t = this.peek();
    if (t.type === 'OP' && CMP_OPS.has(t.value)) {
      this.next();
      const right = this.parsePrimary();
      const t2 = this.peek();
      if (t2.type === 'OP' && CMP_OPS.has(t2.value)) {
        throw new DslSyntaxError('comparison operators are non-associative; use parentheses or and/or', t2.pos);
      }
      return { type: 'cmp', op: t.value, left, right };
    }
    return left;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'NUMBER') { this.next(); return { type: 'num', value: t.value }; }
    if (t.type === 'TIME') { this.next(); return { type: 'time', value: t.value }; }
    if (t.type === 'STRING') { this.next(); return { type: 'str', value: t.value }; }
    if (t.type === 'KEYWORD' && (t.value === 'true' || t.value === 'false')) {
      this.next();
      return { type: 'bool', value: t.value === 'true' };
    }
    if (t.type === 'IDENT') {
      this.next();
      const bound = this.lookup(t.value);
      if (bound !== undefined) {
        return { type: 'ref', name: t.value, letIndex: bound };
      }
      return { type: 'field', name: t.value };
    }
    if (t.type === 'PUNCT' && t.value === '(') {
      this.next();
      const expr = this.parseOr();
      this.expect('PUNCT', ')');
      return expr;
    }
    throw new DslSyntaxError(
      `unexpected ${t.type === 'EOF' ? 'end of input' : `'${t.value}'`}`,
      t.pos,
    );
  }

  lookup(name) {
    for (let s = this.scope.length - 1; s >= 0; s--) {
      if (this.scope[s].has(name)) return this.scope[s].get(name);
    }
    return undefined;
  }

  parseAgg() {
    const t = this.peek();
    if (t.type !== 'IDENT' || !AGG_FUNCS.has(t.value)) {
      throw new DslSyntaxError(
        `expected an aggregation (count, sum, avg, min, max) but got '${t.value}'`,
        t.pos,
      );
    }
    this.next();
    const fn = t.value;
    if (fn === 'count') {
      return { type: 'agg', fn, field: null };
    }
    this.expect('PUNCT', '(');
    const field = this.expect('IDENT').value;
    this.expect('PUNCT', ')');
    return { type: 'agg', fn, field };
  }
}

export function parse(src) {
  return new Parser(tokenize(src)).parseProgram();
}
