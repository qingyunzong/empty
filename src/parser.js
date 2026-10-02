// Statement parser + Pratt expression parser for the planning DSL.

import { tokenize, durationValue, instantValue, timeValue, LexError } from './lexer.js';

export class ParseError extends Error {
  constructor(msg, line) {
    super(`line ${line}: ${msg}`);
    this.name = 'ParseError';
  }
}

// Binding powers for the Pratt parser (higher binds tighter).
const BIN_BP = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
};

class Parser {
  constructor(src) {
    this.src = src;
    this.toks = tokenize(src);
    this.i = 0;
  }

  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }

  expect(t, v) {
    const tok = this.next();
    if (tok.t !== t || (v !== undefined && tok.v !== v)) {
      throw new ParseError(`expected ${v ?? t}, got '${tok.v}' (${tok.t})`, tok.line);
    }
    return tok;
  }

  is(t, v) {
    const tok = this.peek();
    return tok.t === t && (v === undefined || tok.v === v);
  }

  // ---- Pratt expression parser ----
  parseExpr(minBp = 1) {
    let lhs = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      const bp = (tok.t === 'op' || (tok.t === 'punct' && BIN_BP[tok.v])) ? BIN_BP[tok.v] : undefined;
      if (bp === undefined || bp < minBp) return lhs;
      this.next();
      const rhs = this.parseExpr(bp + 1); // left associative
      lhs = { t: 'bin', op: tok.v, l: lhs, r: rhs };
    }
  }

  parsePrefix() {
    const tok = this.next();
    switch (tok.t) {
      case 'int': return { t: 'int', v: parseInt(tok.v, 10) };
      case 'duration': return { t: 'dur', v: durationValue(tok.v) };
      case 'instant': return { t: 'inst', v: instantValue(tok.v) };
      case 'ident': {
        if (this.is('punct', '(')) {
          this.next();
          const args = [];
          if (!this.is('punct', ')')) {
            for (;;) {
              args.push(this.parseExpr());
              if (this.is('punct', ',')) { this.next(); continue; }
              break;
            }
          }
          this.expect('punct', ')');
          return { t: 'call', name: tok.v, args };
        }
        return { t: 'var', name: tok.v };
      }
      case 'punct':
        if (tok.v === '(') {
          const e = this.parseExpr();
          this.expect('punct', ')');
          return e;
        }
        if (tok.v === '-') return { t: 'un', op: '-', e: this.parsePrefix() };
        if (tok.v === '!') return { t: 'un', op: '!', e: this.parsePrefix() };
        throw new ParseError(`unexpected '${tok.v}' in expression`, tok.line);
      default:
        throw new ParseError(`unexpected '${tok.v}' in expression`, tok.line);
    }
  }

  // ---- statements ----
  parseJobBody() {
    // body fields until '}' (caller consumes it); values are expressions
    const body = { duration: null, priority: null, lines: null };
    for (;;) {
      if (this.is('kw', 'duration')) { this.next(); body.duration = this.parseExpr(); continue; }
      if (this.is('kw', 'priority')) { this.next(); body.priority = this.parseExpr(); continue; }
      if (this.is('kw', 'lines')) {
        this.next();
        const names = [this.expect('ident').v];
        while (this.is('punct', ',')) { this.next(); names.push(this.expect('ident').v); }
        body.lines = names;
        continue;
      }
      break;
    }
    return body;
  }

  parseJobLike(kind) {
    // job NAME { body } | job NAME = tmpl(args)
    const name = this.expect('ident').v;
    if (this.is('punct', '{')) {
      this.next();
      const body = this.parseJobBody();
      this.expect('punct', '}');
      return { kind, name, body };
    }
    if (this.is('punct', '=')) {
      this.next();
      const tmpl = this.expect('ident').v;
      this.expect('punct', '(');
      const args = [];
      if (!this.is('punct', ')')) {
        for (;;) {
          args.push(this.parseExpr());
          if (this.is('punct', ',')) { this.next(); continue; }
          break;
        }
      }
      this.expect('punct', ')');
      return { kind, name, template: tmpl, args };
    }
    throw new ParseError(`expected '{' or '=' after ${kind} ${name}`, this.peek().line);
  }

  parseStatements() {
    const stmts = [];
    while (!this.is('eof')) {
      const tok = this.next();
      if (tok.t !== 'kw') throw new ParseError(`expected a statement, got '${tok.v}'`, tok.line);
      switch (tok.v) {
        case 'line':
          stmts.push({ kind: 'line', name: this.expect('ident').v });
          break;
        case 'calendar': {
          const line = this.expect('ident').v;
          this.expect('punct', '{');
          const shifts = [];
          while (!this.is('punct', '}')) {
            this.expect('kw', 'shift');
            const s = this.expect('time').v;
            this.expect('punct', '-');
            const e = this.expect('time').v;
            const sm = timeValue(s), em = timeValue(e);
            if (em <= sm) throw new ParseError(`shift ${s}-${e} must end after it starts`, tok.line);
            shifts.push([sm, em]);
          }
          this.next();
          stmts.push({ kind: 'calendar', line, shifts });
          break;
        }
        case 'maintenance': {
          const line = this.expect('ident').v;
          const at = this.expect('instant').v;
          this.expect('kw', 'for');
          const dur = this.expect('duration').v;
          stmts.push({ kind: 'maintenance', line, start: instantValue(at), dur: durationValue(dur) });
          break;
        }
        case 'let': {
          const name = this.expect('ident').v;
          this.expect('punct', '=');
          stmts.push({ kind: 'let', name, expr: this.parseExpr() });
          break;
        }
        case 'template': {
          const name = this.expect('ident').v;
          this.expect('punct', '(');
          const params = [];
          if (!this.is('punct', ')')) {
            for (;;) {
              params.push(this.expect('ident').v);
              if (this.is('punct', ',')) { this.next(); continue; }
              break;
            }
          }
          this.expect('punct', ')');
          this.expect('punct', '{');
          const body = this.parseJobBody();
          this.expect('punct', '}');
          stmts.push({ kind: 'template', name, params, body });
          break;
        }
        case 'job':
          stmts.push(this.parseJobLike('job'));
          break;
        case 'add-job':
          stmts.push(this.parseJobLike('add-job'));
          break;
        case 'move-job': {
          const job = this.expect('ident').v;
          const line = this.expect('ident').v;
          stmts.push({ kind: 'move-job', job, line });
          break;
        }
        case 'savepoint':
          stmts.push({ kind: 'savepoint', name: this.expect('ident').v });
          break;
        case 'rollback':
          stmts.push({ kind: 'rollback', name: this.expect('ident').v });
          break;
        case 'commit':
          stmts.push({ kind: 'commit' });
          break;
        case 'constraint': {
          const name = this.expect('ident').v;
          const eq = this.expect('punct', '=');
          const expr = this.parseExpr();
          const end = this.peek();
          stmts.push({
            kind: 'constraint', name, expr,
            source: this.src.slice(eq.pos + 1, end.pos).trim(),
          });
          break;
        }
        default:
          throw new ParseError(`unexpected keyword '${tok.v}'`, tok.line);
      }
    }
    return stmts;
  }
}

export function parseScript(src) {
  return new Parser(src).parseStatements();
}

// Parse a standalone constraint expression (used when recompiling persisted constraints).
export function parseConstraintExpr(src) {
  const p = new Parser(src);
  const e = p.parseExpr();
  if (!p.is('eof')) throw new ParseError(`trailing tokens in constraint '${src}'`, p.peek().line);
  return e;
}

export { LexError };
