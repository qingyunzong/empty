import { tokenize } from './lexer.js';
import { CaError } from './errors.js';

const LBP = { '+': 10, '-': 10, '*': 20, '/': 20 };

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek() {
    return this.toks[this.pos];
  }

  next() {
    return this.toks[this.pos++];
  }

  fail(msg, tok = this.peek()) {
    throw new CaError('E_PARSE', `${msg} at ${tok.line}:${tok.col}`);
  }

  expectPunct(v) {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== v) this.fail(`expected '${v}' but got '${t.value || t.type}'`, t);
    return t;
  }

  expectIdent(what = 'identifier') {
    const t = this.next();
    if (t.type !== 'ident') this.fail(`expected ${what}, got '${t.value || t.type}'`, t);
    return t.value;
  }

  // Pratt parser for ratio / cash-alternative expressions.
  parseExpr(bp = 0) {
    const t = this.next();
    let left;
    if (t.type === 'number') left = { k: 'lit', t: 'num', v: t.value };
    else if (t.type === 'cash') left = { k: 'lit', t: 'cash', v: t.value };
    else if (t.type === 'shares') left = { k: 'lit', t: 'shares', v: t.value };
    else if (t.type === 'punct' && t.value === '(') {
      left = this.parseExpr(0);
      this.expectPunct(')');
    } else if (t.type === 'punct' && t.value === '-') {
      left = { k: 'neg', e: this.parseExpr(30) };
    } else {
      this.fail(`unexpected token '${t.value || t.type}' in expression`, t);
    }
    for (;;) {
      const p = this.peek();
      if (p.type !== 'punct' || !(p.value in LBP) || LBP[p.value] <= bp) break;
      const op = this.next().value;
      const right = this.parseExpr(LBP[op]);
      left = { k: 'bin', op, l: left, r: right };
    }
    return left;
  }

  parseProgram() {
    const body = [];
    while (this.peek().type !== 'eof') {
      const t = this.peek();
      if (t.type !== 'ident') this.fail(`expected statement, got '${t.value || t.type}'`, t);
      switch (t.value) {
        case 'action':
          body.push(this.parseAction());
          break;
        case 'apply':
          this.next();
          body.push({ k: 'apply', id: this.expectIdent('action id') });
          break;
        case 'reverse':
          this.next();
          body.push({ k: 'reverse', id: this.expectIdent('action id') });
          break;
        case 'restate':
          body.push(this.parseRestate());
          break;
        case 'sell':
          body.push(this.parseSell());
          break;
        default:
          this.fail(`unknown statement '${t.value}'`, t);
      }
    }
    return { k: 'program', body };
  }

  parseAction() {
    this.next();
    const id = this.expectIdent('action id');
    return { k: 'action', id, fields: this.parseFieldBlock() };
  }

  parseRestate() {
    this.next();
    const id = this.expectIdent('action id');
    return { k: 'restate', id, fields: this.parseFieldBlock() };
  }

  parseFieldBlock() {
    this.expectPunct('{');
    const fields = [];
    while (!(this.peek().type === 'punct' && this.peek().value === '}')) {
      if (this.peek().type === 'eof') this.fail('unterminated block');
      const nameTok = this.next();
      if (nameTok.type !== 'ident') this.fail(`expected field name, got '${nameTok.value || nameTok.type}'`, nameTok);
      fields.push(this.parseField(nameTok.value, nameTok));
    }
    this.expectPunct('}');
    return fields;
  }

  parseField(name, nameTok) {
    switch (name) {
      case 'security':
      case 'kind':
        return { name, value: this.expectIdent(name) };
      case 'ratio':
      case 'cash':
      case 'cashinlieu':
        return { name, expr: this.parseExpr(0) };
      case 'exdate': {
        const t = this.next();
        if (t.type !== 'date') this.fail(`expected YYYY-MM-DD for 'exdate', got '${t.value || t.type}'`, t);
        return { name, value: t.value };
      }
      case 'version': {
        const t = this.next();
        if (t.type !== 'number' || t.value.includes('.')) this.fail(`expected integer for 'version'`, t);
        return { name, value: t.value };
      }
      default:
        this.fail(`unknown field '${name}'`, nameTok);
    }
  }

  parseSell() {
    this.next();
    const security = this.expectIdent('security');
    const qty = this.parseExpr(0);
    const onTok = this.next();
    if (onTok.type !== 'ident' || onTok.value !== 'on') this.fail(`expected 'on' in sell statement`, onTok);
    const d = this.next();
    if (d.type !== 'date') this.fail(`expected YYYY-MM-DD after 'on'`, d);
    return { k: 'sell', security, qty, date: d.value };
  }
}

export function parse(src) {
  return new Parser(tokenize(src)).parseProgram();
}
