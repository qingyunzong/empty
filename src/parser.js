import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(msg, tok) {
    super(tok ? `parse error at ${tok.line}:${tok.col}: ${msg}` : `parse error: ${msg}`);
    this.name = 'ParseError';
  }
}

const BIN_PREC = {
  or: 1, and: 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
};

const DAYS = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.i = 0;
  }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  at(t, v) { const tk = this.peek(); return tk.t === t && (v === undefined || tk.v === v); }
  eat(t, v) { if (this.at(t, v)) { this.i++; return true; } return false; }
  expect(t, v) {
    const tk = this.next();
    if (tk.t !== t || (v !== undefined && tk.v !== v)) {
      throw new ParseError(`expected ${v ?? t} but found '${tk.v}'`, tk);
    }
    return tk;
  }

  parseProgram() {
    const stmts = [];
    while (!this.at('eof')) stmts.push(this.parseStmt());
    return stmts;
  }

  parseStmt() {
    const tk = this.peek();
    if (tk.t !== 'ident') throw new ParseError(`unexpected token '${tk.v}'`, tk);
    switch (tk.v) {
      case 'line': return this.parseLines();
      case 'calendar': return this.parseCalendar();
      case 'maintenance': return this.parseMaintenance();
      case 'template': return this.parseTemplate();
      case 'job': return this.parseJob('job');
      case 'constraint': {
        this.next();
        const expr = this.parseExpr();
        this.expect('punct', ';');
        return { kind: 'constraint', expr };
      }
      case 'add': {
        this.next();
        this.expect('op', '-');
        this.expect('ident', 'job');
        return this.parseJob('add-job', true);
      }
      case 'move': {
        this.next();
        this.expect('op', '-');
        this.expect('ident', 'job');
        const name = this.expect('ident').v;
        this.expect('ident', 'to');
        const to = this.expect('ident').v;
        this.expect('punct', ';');
        return { kind: 'move-job', name, to };
      }
      case 'savepoint': {
        this.next();
        const name = this.expect('ident').v;
        this.expect('punct', ';');
        return { kind: 'savepoint', name };
      }
      case 'rollback': {
        this.next();
        let name = null;
        if (this.at('ident')) name = this.next().v;
        this.expect('punct', ';');
        return { kind: 'rollback', name };
      }
      case 'commit': {
        this.next();
        this.expect('punct', ';');
        return { kind: 'commit' };
      }
      default: {
        if (this.toks[this.i + 1] && this.toks[this.i + 1].t === 'punct' && this.toks[this.i + 1].v === '(') {
          const name = this.next().v;
          this.expect('punct', '(');
          const args = [];
          if (!this.at('punct', ')')) {
            do { args.push(this.parseExpr()); } while (this.eat('punct', ','));
          }
          this.expect('punct', ')');
          this.expect('punct', ';');
          return { kind: 'call', name, args };
        }
        throw new ParseError(`unknown statement starting with '${tk.v}'`, tk);
      }
    }
  }

  parseLines() {
    this.expect('ident', 'line');
    const names = [this.expect('ident').v];
    while (this.eat('punct', ',')) names.push(this.expect('ident').v);
    this.expect('punct', ';');
    return { kind: 'lines', names };
  }

  parseTimeOfDay() {
    const h = this.expect('int').v;
    this.expect('punct', ':');
    const m = this.expect('int').v;
    if (h > 23 || m > 59) throw new ParseError(`invalid time of day ${h}:${m}`, this.peek());
    return h * 60 + m;
  }

  parseCalendar() {
    this.expect('ident', 'calendar');
    const name = this.expect('ident').v;
    this.expect('punct', '{');
    const shifts = [];
    while (!this.eat('punct', '}')) {
      this.expect('ident', 'shift');
      const d1 = this.expect('ident').v;
      let d2 = d1;
      if (this.eat('op', '..')) d2 = this.expect('ident').v;
      if (!(d1 in DAYS) || !(d2 in DAYS)) throw new ParseError(`unknown weekday '${d1}..${d2}'`, this.peek());
      const from = this.parseTimeOfDay();
      this.expect('op', '-');
      const to = this.parseTimeOfDay();
      if (to <= from) throw new ParseError('shift end must be after shift start', this.peek());
      this.expect('punct', ';');
      shifts.push({ days: [DAYS[d1], DAYS[d2]], from, to });
    }
    return { kind: 'calendar', name, shifts };
  }

  parseMaintenance() {
    this.expect('ident', 'maintenance');
    const line = this.expect('ident').v;
    const at = this.expect('instant').v;
    this.expect('ident', 'for');
    const dur = this.expect('dur');
    this.expect('punct', ';');
    return { kind: 'maintenance', line, at, dur: { v: dur.v, unit: dur.unit } };
  }

  parseTemplate() {
    this.expect('ident', 'template');
    const name = this.expect('ident').v;
    this.expect('punct', '(');
    const params = [];
    if (!this.at('punct', ')')) {
      do {
        const pname = this.expect('ident').v;
        this.expect('punct', ':');
        const ptype = this.expect('ident').v;
        if (!['line', 'duration', 'int', 'instant', 'name'].includes(ptype)) {
          throw new ParseError(`unknown param type '${ptype}'`, this.peek());
        }
        params.push({ name: pname, type: ptype });
      } while (this.eat('punct', ','));
    }
    this.expect('punct', ')');
    this.expect('punct', '{');
    const body = [];
    while (!this.eat('punct', '}')) {
      if (!this.at('ident', 'job')) throw new ParseError('template body may only contain job statements', this.peek());
      body.push(this.parseJob('job'));
    }
    return { kind: 'template', name, params, body };
  }

  parseJob(kind, keywordConsumed = false) {
    if (!keywordConsumed) this.expect('ident', 'job');
    const nameTok = this.expect('ident');
    this.expect('punct', '{');
    const fields = {};
    while (!this.eat('punct', '}')) {
      const key = this.expect('ident').v;
      this.expect('punct', ':');
      if (key === 'after') {
        const refs = [this.parseValue()];
        while (this.eat('punct', ',')) refs.push(this.parseValue());
        fields.after = refs;
      } else if (key === 'line' || key === 'duration' || key === 'priority') {
        fields[key] = this.parseValue();
      } else {
        throw new ParseError(`unknown job field '${key}'`, this.peek());
      }
      this.expect('punct', ';');
    }
    if (kind === 'add-job') this.expect('punct', ';');
    return { kind, name: nameTok.v, fields };
  }

  parseValue() {
    const tk = this.next();
    if (tk.t === 'dur') return { kind: 'dur', v: tk.v, unit: tk.unit };
    if (tk.t === 'int') return { kind: 'int', v: tk.v };
    if (tk.t === 'instant') return { kind: 'instant', v: tk.v };
    if (tk.t === 'ident') return { kind: 'ref', name: tk.v };
    throw new ParseError(`expected a value but found '${tk.v}'`, tk);
  }

  parseExpr(minPrec = 1) {
    let left = this.parsePrefix();
    for (;;) {
      const tk = this.peek();
      let op = null;
      if (tk.t === 'op' && BIN_PREC[tk.v] !== undefined) op = tk.v;
      else if (tk.t === 'ident' && (tk.v === 'and' || tk.v === 'or')) op = tk.v;
      if (!op || BIN_PREC[op] < minPrec) break;
      this.next();
      const right = this.parseExpr(BIN_PREC[op] + 1);
      left = { kind: 'bin', op, l: left, r: right };
    }
    return left;
  }

  parsePrefix() {
    const tk = this.next();
    switch (tk.t) {
      case 'int': return { kind: 'int', v: tk.v };
      case 'dur': return { kind: 'dur', v: tk.v, unit: tk.unit };
      case 'instant': return { kind: 'instant', v: tk.v };
      case 'ident': {
        if (tk.v === 'not') return { kind: 'un', op: 'not', e: this.parsePrefix() };
        if (tk.v === 'true' || tk.v === 'false') return { kind: 'bool', v: tk.v === 'true' };
        if (this.eat('punct', '(')) {
          const args = [];
          if (!this.at('punct', ')')) {
            do { args.push(this.parseExpr()); } while (this.eat('punct', ','));
          }
          this.expect('punct', ')');
          return { kind: 'call', name: tk.v, args };
        }
        return { kind: 'ref', name: tk.v };
      }
      case 'op':
        if (tk.v === '-') return { kind: 'un', op: 'neg', e: this.parsePrefix() };
        throw new ParseError(`unexpected operator '${tk.v}'`, tk);
      case 'punct':
        if (tk.v === '(') {
          const e = this.parseExpr();
          this.expect('punct', ')');
          return e;
        }
        throw new ParseError(`unexpected '${tk.v}'`, tk);
      default:
        throw new ParseError(`unexpected token '${tk.v}'`, tk);
    }
  }
}

export function parse(src) {
  return new Parser(src).parseProgram();
}

export function exprToString(e) {
  switch (e.kind) {
    case 'int': return String(e.v);
    case 'dur': return `${e.v}${e.unit}`;
    case 'instant': return `@${e.v}`;
    case 'bool': return e.v ? 'true' : 'false';
    case 'ref': return e.name;
    case 'call': return `${e.name}(${e.args.map(exprToString).join(', ')})`;
    case 'un': return e.op === 'not' ? `not ${exprToString(e.e)}` : `-${exprToString(e.e)}`;
    case 'bin': return `(${exprToString(e.l)} ${e.op} ${exprToString(e.r)})`;
    default: throw new Error(`cannot stringify expr kind ${e.kind}`);
  }
}
