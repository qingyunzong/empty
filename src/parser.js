import { TT } from './lexer.js';
import { DslError } from './errors.js';

const UNITS = new Set(['kW', 'kWh', 'min', '元']);
const OBJECTIVE_VARS = new Set(['cost', 'peak', 'carbon']);

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek(offset = 0) {
    return this.toks[Math.min(this.pos + offset, this.toks.length - 1)];
  }

  next() {
    const t = this.toks[this.pos];
    if (t.type !== TT.EOF) this.pos += 1;
    return t;
  }

  err(message, tok = this.peek()) {
    return new DslError(message, tok);
  }

  atPunct(value) {
    const t = this.peek();
    return t.type === TT.PUNCT && t.value === value;
  }

  atIdent(value) {
    const t = this.peek();
    return t.type === TT.IDENT && (value === undefined || t.value === value);
  }

  expectPunct(value) {
    if (!this.atPunct(value)) {
      throw this.err(`expected '${value}' but found '${this.peek().value}'`);
    }
    return this.next();
  }

  expectKeyword(value) {
    if (!this.atIdent(value)) {
      throw this.err(`expected '${value}' but found '${this.peek().value}'`);
    }
    return this.next();
  }

  expectName(what) {
    const t = this.peek();
    if (t.type !== TT.IDENT) throw this.err(`expected ${what} but found '${t.value}'`, t);
    return this.next();
  }

  expectNumber() {
    const t = this.peek();
    if (t.type !== TT.NUM) throw this.err(`expected a number but found '${t.value}'`, t);
    return this.next();
  }

  parseProgram() {
    const templates = [];
    const sites = [];
    while (this.peek().type !== TT.EOF) {
      if (this.atIdent('template')) templates.push(this.parseTemplate());
      else if (this.atIdent('site')) sites.push(this.parseSite());
      else throw this.err(`expected 'site' or 'template' but found '${this.peek().value}'`);
    }
    if (sites.length === 0) throw this.err('program declares no site', this.peek());
    return { kind: 'program', templates, sites };
  }

  parseTemplate() {
    const kw = this.expectKeyword('template');
    const name = this.expectName('template name');
    this.expectPunct('{');
    const fields = [];
    while (!this.atPunct('}')) fields.push(this.parseField('template'));
    this.expectPunct('}');
    return { kind: 'template', name: name.value, fields, loc: kw };
  }

  parseSite() {
    const kw = this.expectKeyword('site');
    const name = this.expectName('site name');
    this.expectPunct('{');
    const props = [];
    const templates = [];
    const tasks = [];
    const maintenance = [];
    let objective = null;
    while (!this.atPunct('}')) {
      const t = this.peek();
      if (t.type !== TT.IDENT) throw this.err(`expected a site item but found '${t.value}'`, t);
      switch (t.value) {
        case 'slots':
        case 'slotMinutes':
        case 'costBudget':
        case 'carbonBudget': {
          this.next();
          const num = this.expectNumber();
          props.push({ key: t.value, value: num.value, loc: t });
          break;
        }
        case 'peakLimit': {
          this.next();
          props.push({ key: 'peakLimit', value: this.parseQuantity(), loc: t });
          break;
        }
        case 'tariff':
        case 'carbon': {
          this.next();
          props.push({ key: t.value, value: this.parseProfile(), loc: t });
          break;
        }
        case 'maintenance': {
          this.next();
          const start = this.parseTime();
          this.expectPunct('..');
          const end = this.parseTime();
          maintenance.push({ start, end, loc: t });
          break;
        }
        case 'template':
          templates.push(this.parseTemplate());
          break;
        case 'task':
          tasks.push(this.parseTask());
          break;
        case 'objective': {
          if (objective) throw this.err('duplicate objective', t);
          objective = this.parseObjective();
          break;
        }
        default:
          throw this.err(`unknown site item '${t.value}'`, t);
      }
    }
    this.expectPunct('}');
    return {
      kind: 'site', name: name.value, props, templates, tasks, maintenance, objective, loc: kw,
    };
  }

  parseProfile() {
    if (this.atPunct('{')) {
      this.expectPunct('{');
      const blocks = [];
      while (!this.atPunct('}')) {
        const start = this.parseTime();
        this.expectPunct('..');
        const end = this.parseTime();
        this.expectPunct('->');
        const price = this.parseQuantity(true);
        blocks.push({ start, end, price });
      }
      this.expectPunct('}');
      return { kind: 'blocks', blocks };
    }
    return { kind: 'flat', value: this.parseQuantity(true) };
  }

  parseTask() {
    const kw = this.expectKeyword('task');
    const name = this.expectName('task id');
    let templateRef = null;
    if (this.atPunct(':')) {
      this.next();
      templateRef = this.expectName('template name');
    }
    this.expectPunct('{');
    const fields = [];
    while (!this.atPunct('}')) fields.push(this.parseField('task'));
    this.expectPunct('}');
    return {
      kind: 'task',
      id: name.value,
      templateRef: templateRef ? templateRef.value : null,
      templateLoc: templateRef ?? null,
      fields,
      loc: kw,
    };
  }

  parseField(ctx) {
    const t = this.peek();
    if (t.type !== TT.IDENT) throw this.err(`expected a field name but found '${t.value}'`, t);
    switch (t.value) {
      case 'power':
      case 'duration':
      case 'energy':
        this.next();
        return { field: t.value, value: this.parseQuantity(), loc: t };
      case 'interruptible': {
        this.next();
        const v = this.expectName("'true' or 'false'");
        if (v.value !== 'true' && v.value !== 'false') {
          throw this.err(`expected 'true' or 'false' but found '${v.value}'`, v);
        }
        return { field: 'interruptible', value: v.value === 'true', loc: t };
      }
      case 'maxInterrupts': {
        this.next();
        const num = this.expectNumber();
        return { field: 'maxInterrupts', value: num.value, loc: t };
      }
      case 'window': {
        this.next();
        const start = this.parseTime();
        this.expectPunct('..');
        const end = this.parseTime();
        return { field: 'window', value: { start, end }, loc: t };
      }
      case 'after':
      case 'before': {
        if (ctx === 'template') throw this.err(`'${t.value}' is not allowed in a template`, t);
        this.next();
        const ref = this.expectName('task id');
        return { field: t.value, value: ref.value, loc: t };
      }
      default:
        throw this.err(`unknown field '${t.value}'`, t);
    }
  }

  parseQuantity(allowPriceUnit = false) {
    const num = this.expectNumber();
    let unit = null;
    if (this.peek().type === TT.IDENT && UNITS.has(this.peek().value)) {
      unit = this.next().value;
      if (unit === '元' && !allowPriceUnit) {
        throw this.err("unit '元' is only valid for prices", num);
      }
    }
    return { value: num.value, unit, loc: num };
  }

  parseTime() {
    const t = this.peek();
    if (t.type !== TT.TIME) throw this.err(`expected a time like 08:00 but found '${t.value}'`, t);
    this.next();
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.value);
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 24 || mm > 59 || (hh === 24 && mm !== 0)) {
      throw this.err(`invalid time of day '${t.value}'`, t);
    }
    return { text: t.value, minutes: hh * 60 + mm, loc: t };
  }

  parseObjective() {
    const kw = this.expectKeyword('objective');
    this.expectKeyword('minimize');
    const expr = this.parseExpr(0);
    return { kind: 'objective', expr, loc: kw };
  }

  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (t.type !== TT.PUNCT || !'+-*/'.includes(t.value)) break;
      const bp = t.value === '+' || t.value === '-' ? 10 : 20;
      if (bp <= minBp) break;
      this.next();
      const right = this.parseExpr(bp);
      left = { kind: 'bin', op: t.value, left, right, loc: t };
    }
    return left;
  }

  parsePrefix() {
    const t = this.peek();
    if (t.type === TT.NUM) {
      this.next();
      return { kind: 'num', text: t.value, loc: t };
    }
    if (t.type === TT.IDENT) {
      if (!OBJECTIVE_VARS.has(t.value)) throw this.err(`unknown objective variable '${t.value}'`, t);
      this.next();
      return { kind: 'var', name: t.value, loc: t };
    }
    if (this.atPunct('-')) {
      this.next();
      return { kind: 'neg', expr: this.parsePrefix(), loc: t };
    }
    if (this.atPunct('(')) {
      this.next();
      const inner = this.parseExpr(0);
      this.expectPunct(')');
      return inner;
    }
    throw this.err(`expected an expression but found '${t.value}'`, t);
  }
}

export function parse(tokens) {
  return new Parser(tokens).parseProgram();
}
