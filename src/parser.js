import { DslError } from './errors.js';

const RESERVED = new Set([
  'enum', 'signal', 'device', 'rule', 'invariant', 'when', 'set',
  'input', 'output', 'timer', 'bool', 'ms', 'true', 'false',
  'and', 'or', 'not',
]);

const BIN_PREC = {
  or: 1,
  and: 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
};

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek() { return this.toks[this.pos]; }
  next() { return this.toks[this.pos++]; }

  at(value) {
    const t = this.peek();
    return (t.type === 'ident' || t.type === 'punct' || t.type === 'op') && t.value === value;
  }

  error(message, tok = this.peek()) {
    throw new DslError(message, tok.line, tok.col);
  }

  expect(value) {
    if (!this.at(value)) {
      this.error(`expected '${value}' but found '${this.peek().value}'`);
    }
    return this.next();
  }

  expectName(what = 'name') {
    const t = this.peek();
    if (t.type !== 'ident' || RESERVED.has(t.value)) {
      this.error(`expected ${what} but found '${t.value}'`, t);
    }
    return this.next();
  }

  parseProgram() {
    const program = { enums: [], signals: [], devices: [], invariants: []};
    while (this.peek().type !== 'eof') {
      if (this.at('enum')) program.enums.push(this.parseEnum());
      else if (this.at('signal')) program.signals.push(this.parseSignal());
      else if (this.at('device')) program.devices.push(this.parseDevice());
      else if (this.at('invariant')) program.invariants.push(this.parseInvariant());
      else this.error(`unexpected '${this.peek().value}'`);
    }
    return program;
  }

  parseEnum() {
    const kw = this.expect('enum');
    const name = this.expectName('enum name');
    this.expect('{');
    const values = [];
    do {
      const v = this.expectName('enum value');
      values.push({ value: v.value, line: v.line, col: v.col });
    } while (this.at(',') && (this.next(), true));
    this.expect('}');
    return { kind: 'enumDecl', name: name.value, values, line: kw.line, col: kw.col };
  }

  parseSignal() {
    const kw = this.expect('signal');
    const name = this.expectName('signal name');
    this.expect(':');
    const kindTok = this.next();
    if (kindTok.type !== 'ident' || !['input', 'output', 'timer'].includes(kindTok.value)) {
      this.error(`expected 'input', 'output' or 'timer' but found '${kindTok.value}'`, kindTok);
    }
    const type = this.parseType();
    let init = null;
    if (this.at('=')) {
      this.next();
      init = this.parseLiteral();
    }
    return {
      kind: 'signalDecl', name: name.value, sigKind: kindTok.value, type, init,
      line: name.line, col: name.col,
    };
  }

  parseType() {
    const t = this.peek();
    if (t.type === 'ident' && t.value === 'bool') { this.next(); return { kind: 'bool', line: t.line, col: t.col }; }
    if (t.type === 'ident' && t.value === 'ms') { this.next(); return { kind: 'ms', line: t.line, col: t.col }; }
    if (t.type === 'ident' && !RESERVED.has(t.value)) {
      this.next();
      return { kind: 'enum', name: t.value, line: t.line, col: t.col };
    }
    this.error(`expected type ('bool', 'ms' or enum name) but found '${t.value}'`, t);
  }

  parseDevice() {
    const kw = this.expect('device');
    const name = this.expectName('device name');
    this.expect('{');
    const device = { kind: 'deviceDecl', name: name.value, signals: [], rules: [], line: kw.line, col: kw.col };
    while (!this.at('}')) {
      if (this.peek().type === 'eof') this.error(`unexpected '<eof>' inside device '${name.value}'`);
      if (this.at('signal')) device.signals.push(this.parseSignal());
      else if (this.at('rule')) device.rules.push(this.parseRule());
      else this.error(`expected 'signal', 'rule' or '}' but found '${this.peek().value}'`);
    }
    this.next();
    return device;
  }

  parseRule() {
    const kw = this.expect('rule');
    const name = this.expectName('rule name');
    this.expect('when');
    const guard = this.parseExpr();
    this.expect('set');
    const target = this.expectName('signal name');
    this.expect('=');
    const value = this.parseLiteral();
    return {
      kind: 'ruleDecl', name: name.value, guard, target: target.value, value,
      line: kw.line, col: kw.col,
      targetLine: target.line, targetCol: target.col,
    };
  }

  parseInvariant() {
    const kw = this.expect('invariant');
    const expr = this.parseExpr();
    return { kind: 'invariantDecl', expr, line: kw.line, col: kw.col };
  }

  parseLiteral() {
    const t = this.peek();
    if (t.type === 'duration') {
      this.next();
      return { kind: 'duration', value: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'ident' && (t.value === 'true' || t.value === 'false')) {
      this.next();
      return { kind: 'bool', value: t.value === 'true', line: t.line, col: t.col };
    }
    if (t.type === 'ident' && !RESERVED.has(t.value)) {
      this.next();
      return { kind: 'enumLit', name: t.value, line: t.line, col: t.col };
    }
    this.error(`expected literal (true, false, <n>ms or enum value) but found '${t.value}'`, t);
  }

  // Pratt parser: precedence climbing over or / and / comparisons, unary not.
  parseExpr(minPrec = 1) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      let op = null;
      if (t.type === 'ident' && (t.value === 'and' || t.value === 'or')) op = t.value;
      else if (t.type === 'op' && BIN_PREC[t.value] !== undefined) op = t.value;
      if (op === null || BIN_PREC[op] < minPrec) return left;
      this.next();
      const right = this.parseExpr(BIN_PREC[op] + 1);
      if (op === 'and' || op === 'or') {
        left = { kind: op, left, right, line: t.line, col: t.col };
      } else {
        left = { kind: 'cmp', op, left, right, line: t.line, col: t.col };
      }
    }
  }

  parseUnary() {
    const t = this.peek();
    if (t.type === 'ident' && t.value === 'not') {
      this.next();
      return { kind: 'not', expr: this.parseUnary(), line: t.line, col: t.col };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (this.at('(')) {
      this.next();
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (t.type === 'duration') {
      this.next();
      return { kind: 'duration', value: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'ident') {
      if (t.value === 'true' || t.value === 'false') {
        this.next();
        return { kind: 'bool', value: t.value === 'true', line: t.line, col: t.col };
      }
      if (RESERVED.has(t.value)) this.error(`unexpected '${t.value}' in expression`, t);
      this.next();
      return { kind: 'name', name: t.value, line: t.line, col: t.col };
    }
    this.error(`unexpected '${t.value}' in expression`, t);
  }
}

export function parse(tokens) {
  return new Parser(tokens).parseProgram();
}
