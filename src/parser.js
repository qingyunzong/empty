import { ParseError } from './errors.js';
import { lex } from './lexer.js';

const TYPES = new Set(['quantity', 'ratio', 'defect_level']);
const LEVELS = new Set(['none', 'minor', 'major', 'critical']);
const DECISIONS = new Set(['ACCEPT', 'REJECT', 'CONTINUE']);

// Infix binding powers (precedence climbing). Higher binds tighter.
const INFIX_BP = {
  'or': 1,
  'and': 2,
  '<': 3, '<=': 3, '>': 3, '>=': 3, '==': 3, '!=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5,
};
const UNARY_BP = 6;
// `not` binds looser than comparisons (not a >= 1 === not (a >= 1))
// but tighter than `and`/`or`.
const NOT_BP = 3;

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { return this.tokens[this.pos++]; }

  fail(msg, tok = this.peek()) {
    throw new ParseError(msg, { line: tok.line, col: tok.col });
  }

  expectOp(op) {
    const t = this.peek();
    if (t.type !== 'op' || t.value !== op) this.fail(`expected '${op}', found ${describe(t)}`);
    return this.next();
  }

  expectKw(kw) {
    const t = this.peek();
    if (t.type !== 'kw' || t.value !== kw) this.fail(`expected '${kw}', found ${describe(t)}`);
    return this.next();
  }

  isKw(kw) {
    const t = this.peek();
    return t.type === 'kw' && t.value === kw;
  }

  isOp(op) {
    const t = this.peek();
    return t.type === 'op' && t.value === op;
  }

  parseRule() {
    const start = this.expectKw('rule');
    const nameTok = this.peek();
    if (nameTok.type !== 'string') this.fail(`expected rule name string, found ${describe(nameTok)}`);
    const name = this.next().value;

    this.expectKw('version');
    const verTok = this.peek();
    if (verTok.type !== 'num' || !/^\d+$/.test(verTok.value)) {
      this.fail(`expected integer rule version, found ${describe(verTok)}`);
    }
    const version = Number(this.next().value);

    let effective = null;
    if (this.isKw('effective')) {
      this.next();
      const d = this.peek();
      if (d.type !== 'date') this.fail(`expected date (YYYY-MM-DD) after 'effective', found ${describe(d)}`);
      effective = this.next().value;
    }

    let batch = null;
    if (this.isKw('for')) {
      this.next();
      const b = this.peek();
      if (b.type !== 'batchno') this.fail(`expected batch number (e.g. #B-2024-0001) after 'for', found ${describe(b)}`);
      batch = this.next().value;
    }

    this.expectOp('{');
    const params = [];
    const lets = [];
    let decide = null;
    while (!this.isOp('}')) {
      if (this.peek().type === 'eof') this.fail('unexpected end of input: missing }', this.peek());
      if (this.isKw('param')) params.push(this.parseParam());
      else if (this.isKw('let')) lets.push(this.parseLet());
      else if (this.isKw('decide')) {
        if (decide) this.fail('duplicate decide block');
        decide = this.parseDecide();
      } else {
        this.fail(`expected 'param', 'let' or 'decide', found ${describe(this.peek())}`);
      }
    }
    this.expectOp('}');
    if (this.peek().type !== 'eof') this.fail(`unexpected trailing input ${describe(this.peek())}`);
    if (!decide) this.fail('rule is missing a decide block', start);
    if (params.length === 0) this.fail('rule declares no params', start);
    return { kind: 'rule', name, version, effective, batch, params, lets, decide, line: start.line };
  }

  parseParam() {
    const start = this.expectKw('param');
    const nameTok = this.peek();
    if (nameTok.type !== 'ident') this.fail(`expected parameter name, found ${describe(nameTok)}`);
    const name = this.next().value;
    this.expectOp(':');
    const type = this.parseType();
    return { kind: 'param', name, type, line: start.line };
  }

  parseType() {
    const t = this.peek();
    if (t.type !== 'kw' || !TYPES.has(t.value)) {
      this.fail(`expected type (quantity | ratio | defect_level), found ${describe(t)}`);
    }
    return this.next().value;
  }

  parseLet() {
    const start = this.expectKw('let');
    const nameTok = this.peek();
    if (nameTok.type !== 'ident') this.fail(`expected binding name, found ${describe(nameTok)}`);
    const name = this.next().value;
    this.expectOp(':');
    const type = this.parseType();
    this.expectOp('=');
    const expr = this.parseExpr(0);
    return { kind: 'let', name, type, expr, line: start.line };
  }

  parseDecide() {
    const start = this.expectKw('decide');
    this.expectOp('{');
    const lets = [];
    const whens = [];
    let otherwise = null;
    while (!this.isOp('}')) {
      if (this.peek().type === 'eof') this.fail('unexpected end of input inside decide block');
      if (this.isKw('let')) {
        if (whens.length > 0) this.fail("'let' inside decide must come before any 'when'");
        lets.push(this.parseLet());
      } else if (this.isKw('when')) {
        if (otherwise) this.fail("'when' is not allowed after 'otherwise'");
        const w = this.expectKw('when');
        const guard = this.parseExpr(0);
        this.expectOp('->');
        whens.push({ kind: 'when', guard, decision: this.parseDecision(), line: w.line });
      } else if (this.isKw('otherwise')) {
        if (otherwise) this.fail('duplicate otherwise clause');
        const o = this.expectKw('otherwise');
        this.expectOp('->');
        otherwise = { kind: 'otherwise', decision: this.parseDecision(), line: o.line };
      } else {
        this.fail(`expected 'let', 'when' or 'otherwise', found ${describe(this.peek())}`);
      }
    }
    this.expectOp('}');
    if (!otherwise) this.fail("decide block requires a final 'otherwise -> DECISION' clause", start);
    return { kind: 'decide', lets, whens, otherwise, line: start.line };
  }

  parseDecision() {
    const t = this.peek();
    if (t.type !== 'kw' || !DECISIONS.has(t.value)) {
      this.fail(`expected decision (ACCEPT | REJECT | CONTINUE), found ${describe(t)}`);
    }
    return this.next().value;
  }

  // Pratt / precedence-climbing expression parser.
  parseExpr(minBp) {
    const t = this.peek();
    let left;
  if (this.isKw('not')) {
      this.next();
      left = { kind: 'not', expr: this.parseExpr(NOT_BP), line: t.line, col: t.col };
    } else if (this.isOp('-')) {
      this.next();
      left = { kind: 'neg', expr: this.parseExpr(UNARY_BP), line: t.line, col: t.col };
    } else {
      left = this.parsePrimary();
    }

    for (;;) {
      const opTok = this.peek();
      const opVal = opTok.type === 'kw' || opTok.type === 'op' ? opTok.value : null;
      const bp = opVal != null ? INFIX_BP[opVal] : undefined;
      if (bp === undefined || bp < minBp) return left;
      this.next();
      const right = this.parseExpr(bp + 1); // left-associative
      left = { kind: 'bin', op: opVal, left, right, line: opTok.line, col: opTok.col };
    }
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.next();
      return { kind: 'num', value: Number(t.value), line: t.line, col: t.col };
    }
    if (t.type === 'percent') {
      this.next();
      return { kind: 'percent', value: Number(t.value) / 100, line: t.line, col: t.col };
    }
    if (t.type === 'string') {
      this.next();
      return { kind: 'str', value: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'kw' && LEVELS.has(t.value)) {
      this.next();
      return { kind: 'level', value: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'ident') {
      this.next();
      if (this.isOp('(')) {
        this.next();
        const args = [];
        if (!this.isOp(')')) {
          args.push(this.parseExpr(0));
          while (this.isOp(',')) { this.next(); args.push(this.parseExpr(0)); }
        }
        this.expectOp(')');
        return { kind: 'call', name: t.value, args, line: t.line, col: t.col };
      }
      return { kind: 'ident', name: t.value, line: t.line, col: t.col };
    }
    if (this.isOp('(')) {
      this.next();
      const e = this.parseExpr(0);
      this.expectOp(')');
      return e;
    }
    this.fail(`expected expression, found ${describe(t)}`);
  }
}

function describe(tok) {
  if (tok.type === 'eof') return 'end of input';
  return `'${tok.value}' (line ${tok.line})`;
}

export function parse(source) {
  return new Parser(lex(source)).parseRule();
}
