// Parser for the linck rule DSL. Expressions are parsed with a Pratt
// (precedence-climbing) parser; happens-before / concurrent / commutes are
// keyword operators usable both infix (`a happens-before b`) and in call
// form (`happens-before(a, b)`).
//
// Statements are not semicolon-terminated, so an infix operator only
// continues an expression when it appears on the same line as the left
// operand; otherwise the next token starts a new statement.

import { Lexer, DslError } from './lexer.js';

const TYPES = new Set(['int', 'string', 'bool', 'any']);
const CONSTRAINT_KINDS = new Set(['commutes', 'happens-before', 'concurrent']);
const BUILTINS = new Set(['happens-before', 'concurrent', 'commutes']);

// Infix binding powers (higher binds tighter).
const INFIX_BP = {
  or: 10,
  and: 20,
  '==': 30, '!=': 30, '<': 30, '<=': 30, '>': 30, '>=': 30,
  'happens-before': 30, concurrent: 30, commutes: 30, '=~': 30,
  '+': 40, '-': 40,
  '*': 50, '/': 50, '%': 50,
  '.': 70,
};
const PREFIX_BP = 60;

function wildcardToRegexSource(text) {
  let out = '';
  for (const ch of text) {
    if (ch === '*') out += '.*';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return `^${out}$`;
}

class Parser {
  constructor(src) {
    this.lexer = new Lexer(src);
  }

  peek() { return this.lexer.peek(); }
  next() { return this.lexer.next(); }

  error(msg, tok) {
    const t = tok || this.peek();
    throw new DslError(msg, t.line, t.col);
  }

  expectPunct(v) {
    const t = this.next();
    if (!(t.t === 'punct' && t.v === v)) this.error(`expected "${v}" but found ${t.t === 'eof' ? 'end of input' : JSON.stringify(t.v)}`, t);
    return t;
  }

  expectIdent(what = 'identifier') {
    const t = this.next();
    if (t.t !== 'ident') this.error(`expected ${what} but found ${t.t === 'eof' ? 'end of input' : JSON.stringify(t.v)}`, t);
    return t;
  }

  atPunct(v) {
    const t = this.peek();
    return t.t === 'punct' && t.v === v;
  }

  atIdent(v) {
    const t = this.peek();
    return t.t === 'ident' && (v === undefined || t.v === v);
  }

  parseProgram() {
    const decls = [];
    for (;;) {
      const t = this.peek();
      if (t.t === 'eof') break;
      if (t.t === 'ident' && t.v === 'op') decls.push(this.parseOpDecl());
      else if (t.t === 'ident' && t.v === 'rule') decls.push(this.parseRule());
      else this.error(`expected "op" or "rule" but found ${JSON.stringify(t.v)}`, t);
    }
    return { t: 'program', decls };
  }

  parseOpDecl() {
    const kw = this.next(); // 'op'
    const name = this.expectIdent('operation name').v;
    this.expectPunct('(');
    const params = [];
    if (!this.atPunct(')')) {
      for (;;) {
        const pTok = this.expectIdent('parameter name');
        this.expectPunct(':');
        const pType = this.expectIdent('type name');
        if (!TYPES.has(pType.v)) this.error(`unknown type "${pType.v}"`, pType);
        params.push({ name: pTok.v, type: pType.v, line: pTok.line });
        if (this.atPunct(',')) { this.next(); continue; }
        break;
      }
    }
    this.expectPunct(')');
    let ret = null;
    if (this.atPunct('->')) {
      this.next();
      const rt = this.expectIdent('return type');
      if (!TYPES.has(rt.v)) this.error(`unknown type "${rt.v}"`, rt);
      ret = rt.v;
    }
    let effect = null;
    if (this.atIdent('sets')) {
      this.next();
      const keyParam = this.expectIdent('key parameter').v;
      this.expectPunct('=');
      const valueParam = this.expectIdent('value parameter').v;
      effect = { kind: 'sets', keyParam, valueParam };
    } else if (this.atIdent('gets')) {
      this.next();
      const keyParam = this.expectIdent('key parameter').v;
      effect = { kind: 'gets', keyParam };
    }
    return { t: 'opDecl', name, params, ret, effect, line: kw.line };
  }

  parseRule() {
    const kw = this.next(); // 'rule'
    const name = this.expectIdent('rule name').v;
    const body = this.parseBlock();
    return { t: 'rule', name, body, line: kw.line };
  }

  parseBlock() {
    this.expectPunct('{');
    const stmts = [];
    while (!this.atPunct('}')) {
      if (this.peek().t === 'eof') this.error('unterminated block: expected "}"');
      stmts.push(this.parseStmt());
    }
    this.next(); // '}'
    return { t: 'block', stmts };
  }

  parseStmt() {
    const t = this.peek();
    if (t.t === 'ident' && t.v === 'let') {
      this.next();
      const nameTok = this.expectIdent('variable name');
      this.expectPunct('=');
      const expr = this.parseExpr(0);
      return { t: 'let', name: nameTok.v, expr, line: t.line, endLine: expr.endLine };
    }
    if (t.t === 'ident' && CONSTRAINT_KINDS.has(t.v)) {
      this.next();
      const patA = this.parsePattern();
      this.expectPunct(',');
      const patB = this.parsePattern();
      let when = null;
      let endLine = patB.endLine;
      if (this.atIdent('when')) {
        this.next();
        when = this.parseExpr(0);
        endLine = when.endLine;
      }
      return { t: 'constraint', kind: t.v, patA, patB, when, line: t.line, endLine };
    }
    if (t.t === 'punct' && t.v === '{') return this.parseBlock();
    this.error(`expected let, constraint or block but found ${JSON.stringify(t.v)}`, t);
  }

  parsePattern() {
    const nameTok = this.expectIdent('operation name');
    this.expectPunct('(');
    const args = [];
    if (!this.atPunct(')')) {
      for (;;) {
        args.push(this.parsePatternArg());
        if (this.atPunct(',')) { this.next(); continue; }
        break;
      }
    }
    const close = this.expectPunct(')');
    return { t: 'pattern', op: nameTok.v, args, line: nameTok.line, endLine: close.line };
  }

  parsePatternArg() {
    const t = this.peek();
    if (t.t === 'ident') {
      if (t.v === '_') { this.next(); return { t: 'wild', line: t.line }; }
      if (t.v === 'true' || t.v === 'false') { this.next(); return { t: 'lit', v: t.v === 'true', line: t.line }; }
      if (t.v === 'null') { this.next(); return { t: 'lit', v: null, line: t.line }; }
      this.next();
      return { t: 'var', name: t.v, line: t.line };
    }
    if (t.t === 'num') { this.next(); return { t: 'lit', v: t.v, line: t.line }; }
    if (t.t === 'str') {
      this.next();
      if (t.v.includes('*')) return { t: 'regex', source: wildcardToRegexSource(t.v), line: t.line };
      return { t: 'lit', v: t.v, line: t.line };
    }
    if (t.t === 'punct' && t.v === '/') {
      const re = this.lexer.readRegex();
      return { t: 'regex', source: re.v, line: re.line };
    }
    if (t.t === 'punct' && t.v === '-') {
      this.next();
      const n = this.next();
      if (n.t !== 'num') this.error('expected number after "-"', n);
      return { t: 'lit', v: -n.v, line: t.line };
    }
    this.error(`expected pattern argument but found ${JSON.stringify(t.v)}`, t);
  }

  // Pratt expression parser.
  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      let op = null;
      if (t.t === 'punct' && INFIX_BP[t.v] !== undefined) op = t.v;
      else if (t.t === 'ident' && INFIX_BP[t.v] !== undefined) op = t.v;
      if (op === null) break;
      const bp = INFIX_BP[op];
      if (bp <= minBp) break;
      // An infix operator must share the line with its left operand;
      // otherwise it begins a new statement.
      if (t.line > left.endLine) break;
      this.next();
      if (op === '.') {
        const field = this.expectIdent('field name');
        left = { t: 'field', obj: left, name: field.v, line: t.line, endLine: field.line };
        continue;
      }
      if (op === '=~') {
        const reTok = this.peek();
        let source;
        let endLine;
        if (reTok.t === 'punct' && reTok.v === '/') {
          const re = this.lexer.readRegex();
          source = re.v;
          endLine = re.line;
        } else if (reTok.t === 'str') {
          this.next();
          source = wildcardToRegexSource(reTok.v);
          endLine = reTok.line;
        } else {
          this.error('expected regex literal or wildcard string after "=~"', reTok);
        }
        left = { t: 'match', l: left, source, line: t.line, endLine };
        continue;
      }
      const right = this.parseExpr(bp);
      left = { t: 'bin', op, l: left, r: right, line: t.line, endLine: right.endLine };
    }
    return left;
  }

  parsePrefix() {
    const t = this.next();
    if (t.t === 'num') return { t: 'num', v: t.v, line: t.line, endLine: t.line };
    if (t.t === 'str') return { t: 'str', v: t.v, line: t.line, endLine: t.line };
    if (t.t === 'punct' && t.v === '(') {
      const e = this.parseExpr(0);
      const close = this.expectPunct(')');
      return { ...e, endLine: close.line };
    }
    if (t.t === 'punct' && t.v === '-') {
      const e = this.parseExpr(PREFIX_BP);
      return { t: 'un', op: '-', e, line: t.line, endLine: e.endLine };
    }
    if (t.t === 'ident') {
      if (t.v === 'true' || t.v === 'false') return { t: 'bool', v: t.v === 'true', line: t.line, endLine: t.line };
      if (t.v === 'null') return { t: 'null', line: t.line, endLine: t.line };
      if (t.v === 'not') {
        const e = this.parseExpr(PREFIX_BP);
        return { t: 'un', op: 'not', e, line: t.line, endLine: e.endLine };
      }
      if (BUILTINS.has(t.v) && this.atPunct('(')) {
        this.next(); // '('
        const args = [];
        if (!this.atPunct(')')) {
          for (;;) {
            args.push(this.parseExpr(0));
            if (this.atPunct(',')) { this.next(); continue; }
            break;
          }
        }
        const close = this.expectPunct(')');
        return { t: 'call', name: t.v, args, line: t.line, endLine: close.line };
      }
      return { t: 'var', name: t.v, line: t.line, endLine: t.line };
    }
    this.error(`expected expression but found ${t.t === 'eof' ? 'end of input' : JSON.stringify(t.v)}`, t);
  }
}

export function parse(src) {
  return new Parser(src).parseProgram();
}
