import { RiskError } from './errors.js';
import { tokenize } from './lexer.js';
import { parseCidr, parseIp } from './ip.js';

const DECISIONS = new Set(['allow', 'review', 'deny']);
const SCOPE_KINDS = new Set(['global', 'channel', 'merchant']);
const CMP_PUNCT = new Set(['>', '>=', '<', '<=', '==', '!=']);

class Parser {
  constructor(tokens) {
    this.t = tokens;
    this.i = 0;
  }

  peek() {
    return this.t[this.i];
  }

  next() {
    return this.t[this.i++];
  }

  isPunct(v) {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }

  expectPunct(v) {
    if (!this.isPunct(v)) {
      throw new RiskError('E_PARSE', `expected "${v}" but found ${describe(this.peek())}`, this.peek().pos);
    }
    return this.next();
  }

  isKw(w) {
    const t = this.peek();
    return t.type === 'ident' && t.value === w;
  }

  expectKw(w) {
    if (!this.isKw(w)) {
      throw new RiskError('E_PARSE', `expected keyword "${w}" but found ${describe(this.peek())}`, this.peek().pos);
    }
    return this.next();
  }

  expectIdent() {
    const t = this.peek();
    if (t.type !== 'ident') {
      throw new RiskError('E_PARSE', `expected identifier but found ${describe(t)}`, t.pos);
    }
    return this.next();
  }

  expectStr() {
    const t = this.peek();
    if (t.type !== 'str') {
      throw new RiskError('E_PARSE', `expected string literal but found ${describe(t)}`, t.pos);
    }
    return this.next();
  }

  parseProgram() {
    const versions = [];
    const seen = new Set();
    while (this.peek().type !== 'eof') {
      const v = this.parseVersion();
      if (seen.has(v.id)) {
        throw new RiskError('E_VERSION', `duplicate version "${v.id}"`, v.pos);
      }
      seen.add(v.id);
      versions.push(v);
    }
    if (versions.length === 0) {
      throw new RiskError('E_VERSION', 'rule file contains no version block');
    }
    return { kind: 'program', versions };
  }

  parseVersion() {
    const kw = this.expectKw('version');
    const id = this.expectStr().value;
    this.expectKw('since');
    const sinceTok = this.expectStr();
    const sinceMs = Date.parse(sinceTok.value);
    if (Number.isNaN(sinceMs)) {
      throw new RiskError('E_VERSION', `invalid since timestamp "${sinceTok.value}"`, sinceTok.pos);
    }
    this.expectPunct('{');
    const body = this.parseBody();
    return { kind: 'version', id, since: sinceTok.value, sinceMs, body, pos: kw.pos };
  }

  parseBody() {
    const decls = [];
    while (!this.isPunct('}')) {
      if (this.peek().type === 'eof') {
        throw new RiskError('E_PARSE', 'unexpected end of input, missing "}"', this.peek().pos);
      }
      decls.push(this.parseDecl());
    }
    this.expectPunct('}');
    return decls;
  }

  parseDecl() {
    if (this.isKw('scope')) return this.parseScope();
    if (this.isKw('threshold') || this.isKw('override')) return this.parseThreshold();
    if (this.isKw('whitelist')) return this.parseWhitelist();
    if (this.isKw('rule')) return this.parseRule();
    throw new RiskError('E_PARSE', `unexpected ${describe(this.peek())}`, this.peek().pos);
  }

  parseScope() {
    const kw = this.expectKw('scope');
    const kindTok = this.expectIdent();
    if (!SCOPE_KINDS.has(kindTok.value)) {
      throw new RiskError('E_PARSE', `unknown scope kind "${kindTok.value}" (global|channel|merchant)`, kindTok.pos);
    }
    let arg = null;
    if (kindTok.value !== 'global') {
      this.expectPunct('(');
      arg = this.expectStr().value;
      this.expectPunct(')');
    }
    this.expectPunct('{');
    const body = this.parseBody();
    return { kind: 'scope', scopeKind: kindTok.value, arg, body, pos: kw.pos };
  }

  parseThreshold() {
    let isOverride = false;
    if (this.isKw('override')) {
      this.next();
      isOverride = true;
    }
    const kw = this.expectKw('threshold');
    const name = this.expectIdent().value;
    this.expectPunct(':');
    const typeTok = this.expectIdent();
    if (!['money', 'count', 'cidr'].includes(typeTok.value)) {
      throw new RiskError('E_TYPE', `unknown threshold type "${typeTok.value}" (money|count|cidr)`, typeTok.pos);
    }
    this.expectPunct('=');
    const t = this.next();
    let value;
    if (typeTok.value === 'cidr') {
      if (t.type !== 'cidr') {
        throw new RiskError('E_TYPE', 'cidr threshold requires a CIDR literal like 10.0.0.0/8', t.pos);
      }
      value = { kind: 'cidr', ...parseCidr(t.value, t.pos), display: t.value, pos: t.pos };
    } else {
      if (t.type !== 'num') {
        throw new RiskError('E_TYPE', `${typeTok.value} threshold requires a number literal`, t.pos);
      }
      value = { kind: 'num', raw: t.value, pos: t.pos };
    }
    this.expectPunct(';');
    return { kind: 'threshold', name, type: typeTok.value, value, override: isOverride, pos: kw.pos };
  }

  parseWhitelist() {
    const kw = this.expectKw('whitelist');
    const name = this.expectIdent().value;
    this.expectPunct('=');
    const t = this.next();
    if (t.type !== 'regex') {
      throw new RiskError('E_PARSE', 'whitelist requires a regex literal like /^MCH[0-9]+$/', t.pos);
    }
    this.expectPunct(';');
    return { kind: 'whitelist', name, regex: t.value, pos: kw.pos };
  }

  parseRule() {
    const kw = this.expectKw('rule');
    const id = this.expectIdent().value;
    this.expectPunct('{');
    this.expectKw('when');
    const expr = this.parseExpr(0);
    this.expectKw('then');
    const d = this.expectIdent();
    if (!DECISIONS.has(d.value)) {
      throw new RiskError('E_PARSE', `unknown decision "${d.value}" (allow|review|deny)`, d.pos);
    }
    this.expectPunct('}');
    return { kind: 'rule', id, expr, decision: d.value, pos: kw.pos };
  }

  // Pratt parser: or(1) < and(2) < not(2.5) < comparison/in(3)
  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const t = this.peek();
      if (t.type === 'ident' && (t.value === 'and' || t.value === 'or')) {
        const bp = t.value === 'or' ? 1 : 2;
        if (bp <= minBp) break;
        this.next();
        const right = this.parseExpr(bp);
        left = { kind: 'bin', op: t.value, l: left, r: right, pos: t.pos };
        continue;
      }
      if (t.type === 'ident' && t.value === 'in') {
        if (minBp >= 3) break;
        this.next();
        const right = this.parseExpr(3);
        left = { kind: 'in', l: left, r: right, pos: t.pos };
        continue;
      }
      if (t.type === 'punct' && CMP_PUNCT.has(t.value)) {
        if (minBp >= 3) break;
        this.next();
        const right = this.parseExpr(3);
        left = { kind: 'bin', op: t.value, l: left, r: right, pos: t.pos };
        continue;
      }
      break;
    }
    return left;
  }

  parsePrefix() {
    const t = this.peek();
    if (t.type === 'ident' && t.value === 'not') {
      this.next();
      const e = this.parseExpr(2.5);
      return { kind: 'not', e, pos: t.pos };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.next();
    switch (t.type) {
      case 'num':
        return { kind: 'num', raw: t.value, pos: t.pos };
      case 'str':
        return { kind: 'str', value: t.value, pos: t.pos };
      case 'ip':
        return { kind: 'ip', value: parseIp(t.value, t.pos), pos: t.pos };
      case 'cidr':
        return { kind: 'cidr', ...parseCidr(t.value, t.pos), pos: t.pos };
      case 'range':
        return { kind: 'range', lo: t.lo, hi: t.hi, pos: t.pos };
      case 'regex':
        return { kind: 'regex', source: t.value, pos: t.pos };
      case 'ident': {
        if (t.value === 'true') return { kind: 'boollit', value: true, pos: t.pos };
        if (t.value === 'false') return { kind: 'boollit', value: false, pos: t.pos };
        if (t.value === 'event') {
          this.expectPunct('.');
          const field = this.expectIdent();
          return { kind: 'field', name: field.value, pos: t.pos };
        }
        return { kind: 'ref', name: t.value, pos: t.pos };
      }
      case 'punct': {
        if (t.value === '(') {
          const e = this.parseExpr(0);
          this.expectPunct(')');
          return e;
        }
        throw new RiskError('E_PARSE', `unexpected "${t.value}"`, t.pos);
      }
      default:
        throw new RiskError('E_PARSE', `unexpected ${describe(t)}`, t.pos);
    }
  }
}

function describe(t) {
  if (t.type === 'eof') return 'end of input';
  if (t.type === 'range') return `range ${t.lo}..${t.hi}`;
  return `${t.type} ${JSON.stringify(t.value)}`;
}

export function parse(src) {
  return new Parser(tokenize(src)).parseProgram();
}
