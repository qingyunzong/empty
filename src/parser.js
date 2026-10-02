// 语法层：Pratt 表达式解析（目标表达式、数值字段），窗口与先后关系语句
import { tokenize, LangError } from './lexer.js';

export class ParseError extends LangError {
  constructor(message, line, col) {
    super(message, line, col, 'ParseError');
  }
}

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

  atPunct(v) {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }

  expectPunct(v) {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== v) {
      throw new ParseError(`期望 "${v}"，实际得到 "${t.value}"`, t.line, t.col);
    }
    return t;
  }

  expectIdentToken() {
    const t = this.next();
    if (t.type !== 'ident') {
      throw new ParseError(`期望标识符，实际得到 "${t.value}"`, t.line, t.col);
    }
    return t;
  }

  expectEof() {
    const t = this.peek();
    if (t.type !== 'eof') throw new ParseError(`期望文件结束，实际得到 "${t.value}"`, t.line, t.col);
  }

  // Pratt 表达式：+ - (10)，* / (20)，一元 - (30)
  parseExpr(minBp = 0) {
    const t = this.next();
    let left;
    if (t.type === 'num') {
      left = { kind: 'num', value: t.value, line: t.line, col: t.col };
    } else if (t.type === 'ident') {
      left = { kind: 'var', name: t.value, line: t.line, col: t.col };
    } else if (t.type === 'punct' && t.value === '(') {
      left = this.parseExpr(0);
      this.expectPunct(')');
    } else if (t.type === 'punct' && t.value === '-') {
      const expr = this.parseExpr(30);
      left = { kind: 'neg', expr, line: t.line, col: t.col };
    } else {
      throw new ParseError(`表达式中出现意外的 "${t.value}"`, t.line, t.col);
    }
    for (;;) {
      const op = this.peek();
      if (op.type !== 'punct') break;
      let bp;
      if (op.value === '+' || op.value === '-') bp = 10;
      else if (op.value === '*' || op.value === '/') bp = 20;
      else break;
      if (bp <= minBp) break;
      this.next();
      const right = this.parseExpr(bp);
      left = { kind: 'bin', op: op.value, left, right, line: op.line, col: op.col };
    }
    return left;
  }

  parseValue() {
    const expr = this.parseExpr();
    let unit = null;
    if (this.peek().type === 'unit') unit = this.next().value;
    return { expr, unit };
  }

  parseTimeRange() {
    const a = this.next();
    if (a.type !== 'time') throw new ParseError(`期望时刻（HH:MM），实际得到 "${a.value}"`, a.line, a.col);
    this.expectPunct('-');
    const b = this.next();
    if (b.type !== 'time') throw new ParseError(`期望时刻（HH:MM），实际得到 "${b.value}"`, b.line, b.col);
    return {
      from: { text: a.value, line: a.line, col: a.col },
      to: { text: b.value, line: b.line, col: b.col },
    };
  }

  parseBody() {
    const fields = [];
    this.expectPunct('{');
    while (!this.atPunct('}')) {
      const t = this.next();
      if (t.type === 'eof') throw new ParseError('意外的文件结束，缺少 "}"', t.line, t.col);
      if (t.type !== 'ident') throw new ParseError(`期望字段名，实际得到 "${t.value}"`, t.line, t.col);
      switch (t.value) {
        case 'power':
        case 'duration':
        case 'energy':
        case 'maxInterruptions': {
          const v = this.parseValue();
          fields.push({ field: t.value, expr: v.expr, unit: v.unit, line: t.line, col: t.col });
          break;
        }
        case 'window': {
          const range = this.parseTimeRange();
          fields.push({ field: 'window', range, line: t.line, col: t.col });
          break;
        }
        case 'interruptible': {
          const v = this.next();
          if (v.type !== 'ident' || (v.value !== 'true' && v.value !== 'false')) {
            throw new ParseError('interruptible 需要 true 或 false', v.line, v.col);
          }
          fields.push({ field: 'interruptible', value: v.value === 'true', line: t.line, col: t.col });
          break;
        }
        default:
          throw new ParseError(`未知字段 "${t.value}"`, t.line, t.col);
      }
    }
    this.expectPunct('}');
    return fields;
  }

  parseTemplate(kw) {
    const name = this.expectIdentToken();
    let parent = null;
    if (this.atPunct(':')) {
      this.next();
      parent = this.expectIdentToken().value;
    }
    const fields = this.parseBody();
    return { name: name.value, parent, fields, line: kw.line, col: kw.col };
  }

  parseTask(kw) {
    const id = this.expectIdentToken();
    this.expectPunct(':');
    const tpl = this.expectIdentToken();
    let fields = [];
    if (this.atPunct('{')) fields = this.parseBody();
    return { id: id.value, template: tpl.value, fields, line: kw.line, col: kw.col };
  }

  parseOrder(kw) {
    const a = this.expectIdentToken();
    const before = this.next();
    if (before.type !== 'ident' || before.value !== 'before') {
      throw new ParseError('期望 "before"', before.line, before.col);
    }
    const b = this.expectIdentToken();
    return { a: a.value, b: b.value, line: kw.line, col: kw.col };
  }

  site() {
    const kw = this.next();
    if (kw.type !== 'ident' || kw.value !== 'site') {
      throw new ParseError('期望 "site"', kw.line, kw.col);
    }
    const nameTok = this.next();
    if (nameTok.type !== 'str' && nameTok.type !== 'ident') {
      throw new ParseError('期望站点名称', nameTok.line, nameTok.col);
    }
    const site = {
      kind: 'site',
      name: nameTok.value,
      line: kw.line,
      col: kw.col,
      capacity: null,
      tariff: [],
      carbon: [],
      budget: { cost: null, carbon: null },
      templates: [],
      tasks: [],
      orders: [],
      maintenance: [],
      objective: null,
    };
    this.expectPunct('{');
    while (!this.atPunct('}')) {
      const t = this.next();
      if (t.type === 'eof') throw new ParseError('意外的文件结束，缺少 "}"', t.line, t.col);
      if (t.type !== 'ident') throw new ParseError(`意外的 "${t.value}"`, t.line, t.col);
      switch (t.value) {
        case 'capacity': {
          const v = this.parseValue();
          site.capacity = { expr: v.expr, unit: v.unit, line: t.line, col: t.col };
          break;
        }
        case 'tariff':
        case 'carbon': {
          const keyword = t.value === 'tariff' ? 'price' : 'intensity';
          const list = t.value === 'tariff' ? site.tariff : site.carbon;
          this.expectPunct('{');
          while (!this.atPunct('}')) {
            const pk = this.next();
            if (pk.type !== 'ident' || pk.value !== keyword) {
              throw new ParseError(`期望 "${keyword}"，实际得到 "${pk.value}"`, pk.line, pk.col);
            }
            const range = this.parseTimeRange();
            const v = this.parseValue();
            list.push({ ...range, expr: v.expr, unit: v.unit, line: pk.line, col: pk.col });
          }
          this.expectPunct('}');
          break;
        }
        case 'budget': {
          this.expectPunct('{');
          while (!this.atPunct('}')) {
            const bk = this.next();
            if (bk.type !== 'ident' || (bk.value !== 'cost' && bk.value !== 'carbon')) {
              throw new ParseError(`budget 块中期望 "cost" 或 "carbon"，实际得到 "${bk.value}"`, bk.line, bk.col);
            }
            const v = this.parseValue();
            site.budget[bk.value] = { expr: v.expr, unit: v.unit, line: bk.line, col: bk.col };
          }
          this.expectPunct('}');
          break;
        }
        case 'template':
          site.templates.push(this.parseTemplate(t));
          break;
        case 'task':
          site.tasks.push(this.parseTask(t));
          break;
        case 'order':
          site.orders.push(this.parseOrder(t));
          break;
        case 'maintenance': {
          const range = this.parseTimeRange();
          site.maintenance.push({ ...range, line: t.line, col: t.col });
          break;
        }
        case 'minimize': {
          if (site.objective) throw new ParseError('重复的 minimize 语句', t.line, t.col);
          site.objective = { expr: this.parseExpr(), line: t.line, col: t.col };
          break;
        }
        default:
          throw new ParseError(`未知语句 "${t.value}"`, t.line, t.col);
      }
    }
    this.expectPunct('}');
    return site;
  }
}

export function parseSite(text) {
  const p = new Parser(tokenize(text));
  const site = p.site();
  p.expectEof();
  return site;
}

// 增量片段：只允许 task / order 语句
export function parseFragment(text) {
  const p = new Parser(tokenize(text));
  const out = { tasks: [], orders: [] };
  while (p.peek().type !== 'eof') {
    const t = p.peek();
    if (t.type === 'ident' && t.value === 'task') {
      out.tasks.push(p.parseTask(p.next()));
    } else if (t.type === 'ident' && t.value === 'order') {
      out.orders.push(p.parseOrder(p.next()));
    } else {
      throw new ParseError(`增量片段只允许 task/order 语句，实际得到 "${t.value}"`, t.line, t.col);
    }
  }
  return out;
}
