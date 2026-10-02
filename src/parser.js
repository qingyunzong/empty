import { lex } from './lexer.js';
import { parseCidr } from './cidr.js';
import { E } from './errors.js';

export const FIELD_TYPES = {
  ip: 'cidr',
  amount: 'money',
  count: 'count',
  merchant: 'string',
  channel: 'string',
  tag: 'string',
};

export const LEVELS = ['global', 'channel', 'merchant'];
const DECISIONS = new Set(['deny', 'review', 'allow']);
const LBP = { or: 5, and: 10 };
const CMP_BP = 20;
const NOT_BP = 15;

class Parser {
  constructor(tokens) { this.tokens = tokens; this.pos = 0; }
  peek() { return this.tokens[this.pos]; }
  next() { return this.tokens[this.pos++]; }
  expect(type, value) {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      const got = t.type === 'KW' || t.type === 'IDENT' ? `'${t.value}'` : t.type;
      throw E('E_PARSE', `line ${t.line}: expected ${value ?? type}, got ${got}`);
    }
    return t;
  }
  atKw(kw) { const t = this.peek(); return t.type === 'KW' && t.value === kw; }
}

export function parseFile(src) {
  const p = new Parser(lex(src));
  const rulesets = [];
  while (p.peek().type !== 'EOF') rulesets.push(parseRuleset(p));
  if (rulesets.length === 0) throw E('E_PARSE', 'empty rules file');
  return rulesets;
}

function parseRuleset(p) {
  p.expect('KW', 'version');
  const version = parseInt(p.expect('NUMBER').value, 10);
  let validFrom = null;
  if (p.atKw('valid_from')) {
    p.next();
    const ts = p.expect('TS');
    validFrom = Date.parse(ts.value);
    if (Number.isNaN(validFrom)) throw E('E_PARSE', `invalid valid_from timestamp '${ts.value}'`);
  }
  const rules = [];
  while (p.atKw('rule')) rules.push(parseRule(p));
  if (rules.length === 0) throw E('E_PARSE', `version ${version} declares no rules`);
  return { version, validFrom, rules };
}

function parseRule(p) {
  p.expect('KW', 'rule');
  const name = p.expect('IDENT').value;
  p.expect('KW', 'level');
  const level = p.expect('IDENT').value;
  if (!LEVELS.includes(level)) throw E('E_PARSE', `unknown level '${level}' (want global|channel|merchant)`);
  let match = null;
  if (p.atKw('match')) {
    p.next();
    const field = p.expect('IDENT').value;
    if (field !== 'channel' && field !== 'merchant')
      throw E('E_PARSE', `match field must be 'channel' or 'merchant', got '${field}'`);
    if (level === 'global') throw E('E_PARSE', 'global rules cannot have a match clause');
    if (level === 'channel' && field !== 'channel')
      throw E('E_PARSE', 'a channel-level rule must match on channel');
    if (level === 'merchant' && field !== 'merchant')
      throw E('E_PARSE', 'a merchant-level rule must match on merchant');
    const t = p.next();
    if (t.type !== 'STRING' && t.type !== 'IDENT')
      throw E('E_PARSE', `line ${t.line}: match value must be an identifier or string`);
    match = { field, value: t.value };
  }
  p.expect('LBRACE');
  const statements = [];
  while (p.peek().type !== 'RBRACE') statements.push(parseStatement(p));
  p.expect('RBRACE');
  if (statements.length === 0) throw E('E_PARSE', `rule '${name}' has no statements`);
  return { name, level, match, statements };
}

function parseStatement(p) {
  let override = false;
  if (p.atKw('override')) { p.next(); override = true; }
  const kw = p.next();
  if (kw.type !== 'KW' || !DECISIONS.has(kw.value))
    throw E('E_PARSE', `line ${kw.line}: expected deny|review|allow`);
  p.expect('KW', 'when');
  const expr = parseExpr(p, 0);
  return { override, decision: kw.value, expr };
}

function parseExpr(p, minBp) {
  let left = parsePrefix(p);
  for (;;) {
    const t = p.peek();
    if (t.type === 'KW' && (t.value === 'and' || t.value === 'or')) {
      const bp = LBP[t.value];
      if (bp < minBp) break;
      p.next();
      left = { kind: t.value, left, right: parseExpr(p, bp + 1) };
      continue;
    }
    if (t.type === 'OP' && CMP_BP >= minBp) {
      p.next();
      left = finishCmp(p, left, t.value, t.line);
      continue;
    }
    if (t.type === 'KW' && t.value === 'in' && CMP_BP >= minBp) {
      p.next();
      left = finishIn(p, left, t.line);
      continue;
    }
    break;
  }
  return left;
}

function parsePrefix(p) {
  const t = p.next();
  if (t.type === 'KW' && t.value === 'not') return { kind: 'not', expr: parseExpr(p, NOT_BP) };
  if (t.type === 'LPAREN') {
    const e = parseExpr(p, 0);
    p.expect('RPAREN');
    return e;
  }
  if (t.type === 'IDENT') return { kind: 'field', name: t.value };
  if (t.type === 'NUMBER') return { kind: 'countLit', value: parseInt(t.value, 10) };
  if (t.type === 'FLOAT') return { kind: 'floatLit', value: parseFloat(t.value) };
  if (t.type === 'MONEY') return moneyLit(t.value);
  if (t.type === 'STRING') return { kind: 'stringLit', value: t.value };
  throw E('E_PARSE', `line ${t.line}: unexpected token ${t.value ?? t.type}`);
}

function moneyLit(text) {
  const m = text.match(/^(\d+(?:\.\d+)?)([A-Z]{3})$/);
  return { kind: 'moneyLit', amount: parseFloat(m[1]), currency: m[2] };
}

function finishCmp(p, left, op, line) {
  if (left.kind !== 'field')
    throw E('E_TYPE', `line ${line}: left side of '${op}' must be an event field`);
  const t = p.next();
  let value;
  if (t.type === 'MONEY') value = moneyLit(t.value);
  else if (t.type === 'NUMBER') value = { kind: 'countLit', value: parseInt(t.value, 10) };
  else if (t.type === 'FLOAT') value = { kind: 'floatLit', value: parseFloat(t.value) };
  else if (t.type === 'STRING' || t.type === 'IDENT') value = { kind: 'stringLit', value: t.value };
  else throw E('E_PARSE', `line ${t.line}: expected a literal after '${op}'`);
  return { kind: 'cmp', op, field: left.name, value };
}

function finishIn(p, left, line) {
  if (left.kind !== 'field')
    throw E('E_TYPE', `line ${line}: left side of 'in' must be an event field`);
  const t = p.next();
  if (t.type === 'CIDR') return { kind: 'inCidr', field: left.name, cidr: parseCidr(t.value) };
  if (t.type === 'REGEX') {
    try { new RegExp(`^(?:${t.value})$`); }
    catch { throw E('E_PARSE', `line ${line}: invalid regex /${t.value}/`); }
    return { kind: 'matchRegex', field: left.name, regex: t.value };
  }
  if (t.type === 'LBRACKET') {
    const items = [];
    while (p.peek().type !== 'RBRACKET') {
      const it = p.next();
      if (it.type !== 'STRING' && it.type !== 'IDENT')
        throw E('E_PARSE', `line ${it.line}: list items must be strings or identifiers`);
      items.push(it.value);
      if (p.peek().type === 'COMMA') p.next();
      else if (p.peek().type !== 'RBRACKET')
        throw E('E_PARSE', `line ${p.peek().line}: expected ',' or ']'`);
    }
    p.expect('RBRACKET');
    if (items.length === 0) throw E('E_PARSE', `line ${line}: empty list literal`);
    return { kind: 'inList', field: left.name, items };
  }
  const lo = rangeBound(p, t);
  p.expect('DOTDOT');
  const hi = rangeBound(p, p.next());
  return { kind: 'inRange', field: left.name, lo, hi };
}

function rangeBound(p, t) {
  if (t.type === 'MONEY') return moneyLit(t.value);
  if (t.type === 'NUMBER') return { kind: 'countLit', value: parseInt(t.value, 10) };
  throw E('E_PARSE', `line ${t.line}: range bounds must be money or integer literals`);
}
