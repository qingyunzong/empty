import { NetError, E } from './errors.js';
import { tokenize, pctToBp } from './lexer.js';
import { compile, run } from './bytecode.js';

const FIELDS = new Set(['amount', 'id', 'from', 'to', 'currency', 'day']);

const BINOPS = {
  OR: { bp: 10, op: 'or' },
  AND: { bp: 20, op: 'and' },
};
const OP_BP = {
  '==': 30, '!=': 30,
  '<': 40, '<=': 40, '>': 40, '>=': 40,
  '+': 50, '-': 50,
  '*': 60, '/': 60,
};

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
    this.prog = {
      global: { filter: null, nettable: null, expects: [] },
      days: new Map(), // date -> { consts:Map, filter, nettable, expects:[] }
      consts: new Map(), // global consts: name -> typed value
    };
    this.dayConstOwners = new Map(); // name -> date (for cross-day diagnostics)
    this.scopeConsts = this.prog.consts; // active const scope
    this.scopeDay = null;
    this.expectKeys = new Set(); // canonical expect-cycle keys (global dedup)
  }

  peek() { return this.toks[this.pos]; }
  next() { return this.toks[this.pos++]; }

  fail(msg, tok = this.peek()) {
    throw new NetError(E.PARSE, `line ${tok.line}: ${msg}`);
  }

  expect(t, v) {
    const tok = this.next();
    if (tok.t !== t || (v !== undefined && tok.v !== v)) {
      this.fail(`expected ${v !== undefined ? JSON.stringify(v) : t}, got ${tok.t} ${JSON.stringify(tok.v)}`, tok);
    }
    return tok;
  }

  program() {
    while (this.peek().t !== 'EOF') this.statement(this.prog.global);
    return this.prog;
  }

  statement(scope) {
    const tok = this.peek();
    switch (tok.t) {
      case 'CONST': return this.constDecl();
      case 'DAY': return this.dayBlock();
      case 'FILTER': {
        this.next();
        scope.filter = this.expr();
        this.expect('OP', ';');
        return;
      }
      case 'NETTABLE': {
        this.next();
        this.expect('OP', '=');
        scope.nettable = this.expr();
        this.expect('OP', ';');
        return;
      }
      case 'EXPECT': return this.expectCycle(scope);
      default: this.fail(`unexpected token ${tok.t} ${JSON.stringify(tok.v)}`, tok);
    }
  }

  constDecl() {
    this.expect('CONST');
    const name = this.expect('IDENT').v;
    if (/^[A-Z]{3}$/.test(name)) this.fail(`const name ${name} reserved for currency codes`);
    this.expect('OP', '=');
    const ast = this.expr();
    this.expect('OP', ';');
    if (this.scopeConsts.has(name)) this.fail(`duplicate const ${name}`);
    const { code } = compile(ast);
    const value = run(code, null); // LOAD_FIELD in a const throws E_PARSE
    this.scopeConsts.set(name, value);
    if (this.scopeDay !== null) this.dayConstOwners.set(name, this.scopeDay);
  }

  dayBlock() {
    this.expect('DAY');
    const date = this.expect('DATE').v;
    if (this.prog.days.has(date)) this.fail(`duplicate day block ${date}`);
    const scope = { consts: new Map(), filter: null, nettable: null, expects: [] };
    this.prog.days.set(date, scope);
    const savedConsts = this.scopeConsts;
    const savedDay = this.scopeDay;
    this.scopeConsts = scope.consts;
    this.scopeDay = date;
    this.expect('OP', '{');
    while (this.peek().t !== 'OP' || this.peek().v !== '}') this.statement(scope);
    this.expect('OP', '}');
    this.scopeConsts = savedConsts;
    this.scopeDay = savedDay;
  }

  expectCycle(scope) {
    this.expect('EXPECT');
    this.expect('CYCLE');
    const members = [this.memberName()];
    while (this.peek().t === 'ARROW') {
      this.next();
      members.push(this.memberName());
    }
    this.expect('OP', ';');
    if (members.length < 2) this.fail('expect cycle needs at least 2 members');
    if (new Set(members).size !== members.length) this.fail('expect cycle repeats a member');
    const key = canonicalKey(members);
    if (this.expectKeys.has(key)) {
      throw new NetError(E.CYCLE_DUP, `duplicate cycle declaration ${key}`);
    }
    this.expectKeys.add(key);
    scope.expects.push({ members: canonicalMembers(members), key });
  }

  memberName() {
    const tok = this.next();
    if (tok.t === 'MEMBER' || tok.t === 'IDENT') return tok.v;
    this.fail(`expected member, got ${tok.t} ${JSON.stringify(tok.v)}`, tok);
  }

  // ---- Pratt expression parser ----
  expr(minBp = 0) {
    let left = this.prefix();
    for (;;) {
      const tok = this.peek();
      let bp;
      let op;
      if (tok.t === 'AND' || tok.t === 'OR') {
        ({ bp, op } = BINOPS[tok.t]);
      } else if (tok.t === 'OP' && OP_BP[tok.v] !== undefined) {
        bp = OP_BP[tok.v];
        op = tok.v;
      } else {
        break;
      }
      if (bp < minBp) break;
      this.next();
      const right = this.expr(bp + 1);
      left = { t: 'bin', op, l: left, r: right };
    }
    return left;
  }

  prefix() {
    const tok = this.next();
    switch (tok.t) {
      case 'INT': {
        if (this.peek().t === 'CCY') {
          const ccy = this.next().v;
          return { t: 'money', v: BigInt(tok.v), ccy };
        }
        return { t: 'int', v: BigInt(tok.v) };
      }
      case 'PCT': return { t: 'pct', bp: pctToBp(tok.v) };
      case 'STRING': return { t: 'str', v: tok.v };
      case 'MEMBER': return { t: 'member', v: tok.v };
      case 'OBLID': return { t: 'str', v: tok.v };
      case 'CCY': return { t: 'str', v: tok.v };
      case 'OP':
        if (tok.v === '-') return { t: 'un', op: 'neg', a: this.expr(70) };
        if (tok.v === '(') {
          const e = this.expr();
          this.expect('OP', ')');
          return e;
        }
        this.fail(`unexpected operator ${JSON.stringify(tok.v)}`, tok);
        break;
      case 'NOT': return { t: 'un', op: 'not', a: this.expr(70) };
      case 'MIN': case 'MAX': {
        this.expect('OP', '(');
        const a = this.expr();
        this.expect('OP', ',');
        const b = this.expr();
        this.expect('OP', ')');
        return { t: 'call', fn: tok.t.toLowerCase(), args: [a, b] };
      }
      case 'ABS': case 'NET': {
        this.expect('OP', '(');
        const a = this.expr();
        this.expect('OP', ')');
        return { t: 'call', fn: tok.t.toLowerCase(), args: [a] };
      }
      case 'IDENT': return this.identifier(tok);
      default: this.fail(`unexpected token ${tok.t} ${JSON.stringify(tok.v)}`, tok);
    }
  }

  identifier(tok) {
    const name = tok.v;
    const scoped = this.scopeConsts.get(name);
    if (scoped !== undefined) return constToAst(scoped);
    if (this.scopeConsts !== this.prog.consts) {
      const global = this.prog.consts.get(name);
      if (global !== undefined) return constToAst(global);
    }
    const owner = this.dayConstOwners.get(name);
    if (owner !== undefined && owner !== this.scopeDay) {
      this.fail(`cross-day reference to const ${name} (defined in day ${owner})`, tok);
    }
    if (FIELDS.has(name)) return { t: 'field', name };
    this.fail(`undefined identifier ${name}`, tok);
  }
}

function constToAst(value) {
  switch (value.kind) {
    case 'int': return { t: 'int', v: value.v };
    case 'pct': return { t: 'pct', bp: value.bp };
    case 'money': return { t: 'money', v: value.v, ccy: value.ccy };
    case 'str': return { t: 'str', v: value.v };
    case 'member': return { t: 'member', v: value.v };
    case 'bool': return { t: value.v ? 'trueLit' : 'falseLit' };
    default: throw new NetError(E.PARSE, `const of kind ${value.kind} cannot be referenced`);
  }
}

// Rotate so the lexicographically smallest member is first (rotation equivalence).
export function canonicalMembers(members) {
  let best = 0;
  for (let i = 1; i < members.length; i++) {
    if (members[i] < members[best]) best = i;
  }
  return members.slice(best).concat(members.slice(0, best));
}

export function canonicalKey(members) {
  return canonicalMembers(members).join('>');
}

export function parse(src) {
  return new Parser(tokenize(src)).program();
}
