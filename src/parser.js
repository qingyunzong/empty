import { LakeError, E_PARSE, E_UNSUPPORTED } from './errors.js';

const KEYWORDS = new Set([
  'select', 'from', 'where', 'group', 'by', 'having', 'join', 'inner', 'on', 'as',
  'and', 'or', 'not', 'null', 'is', 'true', 'false',
  'count', 'sum', 'avg', 'min', 'max',
]);
const UNSUPPORTED_KEYWORDS = new Set([
  'left', 'right', 'full', 'outer', 'cross', 'natural', 'using', 'distinct', 'order',
  'limit', 'offset', 'union', 'intersect', 'except', 'in', 'like', 'between', 'case',
  'when', 'then', 'else', 'end', 'exists', 'asc', 'desc', 'insert', 'update', 'delete',
  'create', 'drop', 'alter', 'into', 'values', 'set',
]);
const AGG_FUNCS = new Set(['count', 'sum', 'avg', 'min', 'max']);

function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const err = (m) => new LakeError(E_PARSE, `${m} at offset ${i}`);
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const w = sql.slice(i, j);
      const lw = w.toLowerCase();
      if (UNSUPPORTED_KEYWORDS.has(lw)) throw new LakeError(E_UNSUPPORTED, `unsupported keyword: ${w}`);
      tokens.push(KEYWORDS.has(lw) ? { type: 'kw', value: lw, pos: i } : { type: 'ident', value: w, pos: i });
      i = j; continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < sql.length && /[0-9.]/.test(sql[j])) j++;
      const s = sql.slice(i, j);
      if ((s.match(/\./g) || []).length > 1) throw err(`bad number '${s}'`);
      const n = Number(s);
      if (!Number.isFinite(n)) throw err(`bad number '${s}'`);
      tokens.push({ type: 'num', value: n, pos: i });
      i = j; continue;
    }
    if (c === "'") {
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= sql.length) throw err('unterminated string literal');
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { out += "'"; j += 2; continue; }
          j++; break;
        }
        out += sql[j++];
      }
      tokens.push({ type: 'str', value: out, pos: i });
      i = j; continue;
    }
    if ('(),.*;'.includes(c)) { tokens.push({ type: 'punct', value: c, pos: i }); i++; continue; }
    if (c === '=') { tokens.push({ type: 'op', value: '=', pos: i }); i++; continue; }
    if (c === '!') {
      if (sql[i + 1] === '=') { tokens.push({ type: 'op', value: '!=', pos: i }); i += 2; continue; }
      throw err("unexpected '!'");
    }
    if (c === '<') {
      if (sql[i + 1] === '=') { tokens.push({ type: 'op', value: '<=', pos: i }); i += 2; }
      else if (sql[i + 1] === '>') { tokens.push({ type: 'op', value: '<>', pos: i }); i += 2; }
      else { tokens.push({ type: 'op', value: '<', pos: i }); i++; }
      continue;
    }
    if (c === '>') {
      if (sql[i + 1] === '=') { tokens.push({ type: 'op', value: '>=', pos: i }); i += 2; }
      else { tokens.push({ type: 'op', value: '>', pos: i }); i++; }
      continue;
    }
    throw err(`unexpected character '${c}'`);
  }
  tokens.push({ type: 'eof', pos: sql.length });
  return tokens;
}

class Parser {
  constructor(sql) {
    this.tokens = tokenize(sql);
    this.i = 0;
  }
  peek(k = 0) { return this.tokens[Math.min(this.i + k, this.tokens.length - 1)]; }
  next() { return this.tokens[this.i++]; }
  peekKw(w) { const t = this.peek(); return t.type === 'kw' && t.value === w; }
  eatKw(w) { if (this.peekKw(w)) { this.i++; return true; } return false; }
  expectKw(w) {
    if (!this.eatKw(w)) {
      const t = this.peek();
      throw new LakeError(E_PARSE, `expected keyword ${w.toUpperCase()} but found '${t.value ?? t.type}' at offset ${t.pos}`);
    }
  }
  peekPunct(p) { const t = this.peek(); return t.type === 'punct' && t.value === p; }
  eatPunct(p) { if (this.peekPunct(p)) { this.i++; return true; } return false; }
  expectPunct(p) {
    if (!this.eatPunct(p)) {
      const t = this.peek();
      throw new LakeError(E_PARSE, `expected '${p}' but found '${t.value ?? t.type}' at offset ${t.pos}`);
    }
  }
  expectIdent() {
    const t = this.next();
    if (t.type !== 'ident') throw new LakeError(E_PARSE, `expected identifier but found '${t.value ?? t.type}' at offset ${t.pos}`);
    return t.value;
  }
}

function parseColRef(p) {
  const first = p.expectIdent();
  if (p.eatPunct('.')) return { table: first, name: p.expectIdent() };
  return { table: null, name: first };
}

function parseOptAlias(p) {
  if (p.eatKw('as')) return p.expectIdent();
  if (p.peek().type === 'ident') return p.next().value;
  return null;
}

function parseAggCall(p) {
  const func = p.next().value; // kw in AGG_FUNCS
  p.expectPunct('(');
  let arg;
  if (p.eatPunct('*')) arg = '*';
  else arg = parseColRef(p);
  p.expectPunct(')');
  return { kind: 'agg', func, arg };
}

function parseOperand(p) {
  const t = p.peek();
  if (t.type === 'num') { p.next(); return { kind: 'lit', value: t.value }; }
  if (t.type === 'str') { p.next(); return { kind: 'lit', value: t.value }; }
  if (t.type === 'kw') {
    if (t.value === 'null') { p.next(); return { kind: 'lit', value: null }; }
    if (t.value === 'true') { p.next(); return { kind: 'lit', value: true }; }
    if (t.value === 'false') { p.next(); return { kind: 'lit', value: false }; }
    if (AGG_FUNCS.has(t.value)) return parseAggCall(p);
  }
  if (t.type === 'ident') return { kind: 'col', ...parseColRef(p) };
  throw new LakeError(E_PARSE, `expected operand but found '${t.value ?? t.type}' at offset ${t.pos}`);
}

function parsePredicate(p) {
  if (p.eatPunct('(')) {
    const e = parseOr(p);
    p.expectPunct(')');
    return e;
  }
  const left = parseOperand(p);
  if (p.eatKw('is')) {
    const negated = p.eatKw('not');
    p.expectKw('null');
    return { kind: 'isnull', operand: left, negated };
  }
  const t = p.next();
  if (t.type !== 'op') throw new LakeError(E_PARSE, `expected comparison operator but found '${t.value ?? t.type}' at offset ${t.pos}`);
  const right = parseOperand(p);
  return { kind: 'cmp', op: t.value, left, right };
}

function parseNot(p) {
  if (p.eatKw('not')) return { kind: 'not', arg: parseNot(p) };
  return parsePredicate(p);
}

function parseAnd(p) {
  const args = [parseNot(p)];
  while (p.eatKw('and')) args.push(parseNot(p));
  return args.length === 1 ? args[0] : { kind: 'and', args };
}

function parseOr(p) {
  const args = [parseAnd(p)];
  while (p.eatKw('or')) args.push(parseAnd(p));
  return args.length === 1 ? args[0] : { kind: 'or', args };
}

function parseTableRef(p) {
  const name = p.expectIdent();
  const alias = parseOptAlias(p);
  return { name, alias: alias ?? name };
}

function parseSelectItem(p) {
  if (p.eatPunct('*')) return { kind: 'star' };
  const t = p.peek();
  if (t.type === 'kw' && AGG_FUNCS.has(t.value)) {
    const agg = parseAggCall(p);
    return { kind: 'agg', func: agg.func, arg: agg.arg, alias: parseOptAlias(p) };
  }
  if (t.type === 'ident') {
    const col = parseColRef(p);
    return { kind: 'col', col, alias: parseOptAlias(p) };
  }
  if (t.type === 'num' || t.type === 'str' || p.peekPunct('(')) {
    throw new LakeError(E_UNSUPPORTED, 'expressions in SELECT list are not supported (columns and aggregates only)');
  }
  throw new LakeError(E_PARSE, `unexpected token '${t.value ?? t.type}' in SELECT list at offset ${t.pos}`);
}

export function parseSql(sql) {
  const p = new Parser(sql);
  p.expectKw('select');
  const select = [parseSelectItem(p)];
  while (p.eatPunct(',')) select.push(parseSelectItem(p));
  p.expectKw('from');
  const first = parseTableRef(p);
  const joins = [];
  for (;;) {
    if (p.eatKw('join') || (p.peekKw('inner') && p.peek(1).type === 'kw' && p.peek(1).value === 'join' && (p.next(), p.next(), true))) {
      const table = parseTableRef(p);
      p.expectKw('on');
      const on = [];
      for (;;) {
        const left = parseColRef(p);
        const t = p.next();
        if (t.type !== 'op' || t.value !== '=') {
          throw new LakeError(E_UNSUPPORTED, 'only equi-join (ON a = b) is supported');
        }
        const right = parseColRef(p);
        on.push({ left, right });
        if (!p.eatKw('and')) break;
      }
      joins.push({ table, on });
    } else if (p.eatPunct(',')) {
      joins.push({ table: parseTableRef(p), on: [] });
    } else break;
  }
  let where = null;
  if (p.eatKw('where')) where = parseOr(p);
  let groupBy = null;
  if (p.eatKw('group')) {
    p.expectKw('by');
    groupBy = [parseColRef(p)];
    while (p.eatPunct(',')) groupBy.push(parseColRef(p));
  }
  let having = null;
  if (p.eatKw('having')) having = parseOr(p);
  p.eatPunct(';');
  const end = p.peek();
  if (end.type !== 'eof') throw new LakeError(E_PARSE, `unexpected trailing input '${end.value ?? end.type}' at offset ${end.pos}`);
  return { select, from: { table: first, joins }, where, groupBy, having };
}
