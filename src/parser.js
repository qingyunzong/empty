import { QError } from './errors.js';
import { tokenize } from './lexer.js';

class P {
  constructor(toks) { this.toks = toks; this.pos = 0; }
  peek() { return this.toks[this.pos]; }
  next() { return this.toks[this.pos++]; }
  at(v) { return this.peek().value === v; }
  expect(v) {
    const t = this.next();
    if (t.value !== v) throw new QError('E_PARSE', `expected '${v}' but got '${t.value}' at line ${t.line}`);
    return t;
  }
  expectType(ty) {
    const t = this.next();
    if (t.type !== ty) throw new QError('E_PARSE', `expected ${ty} but got '${t.value}' at line ${t.line}`);
    return t;
  }
}

export function parse(src) { return parseProgram(new P(tokenize(src))); }

function parseProgram(p) {
  const prog = { kind: 'program', customer: null, note: null, buckets: [], approvals: [] };
  while (p.peek().type !== 'EOF') {
    const t = p.peek();
    if (t.value === 'customer') {
      p.next();
      prog.customer = p.expectType('CUSTOMER').value;
      p.expect(';');
    } else if (t.value === 'note') {
      p.next();
      prog.note = p.expectType('REGEX').value;
      p.expect(';');
    } else if (t.value === 'bucket') {
      prog.buckets.push(parseBucket(p));
    } else if (t.value === 'approval') {
      prog.approvals.push(parseApproval(p));
    } else {
      throw new QError('E_PARSE', `unexpected '${t.value}' at line ${t.line}`);
    }
  }
  if (!prog.customer) throw new QError('E_PARSE', 'missing customer declaration');
  return prog;
}

function parseBucket(p) {
  p.expect('bucket');
  const name = p.expectType('IDENT').value;
  p.expect('{');
  let limit = null;
  let validFrom = null;
  let validTo = null;
  while (!p.at('}')) {
    if (p.at('limit')) {
      p.next();
      limit = p.expectType('NUMBER').value;
      p.expect(';');
    } else if (p.at('valid')) {
      p.next();
      validFrom = p.expectType('DATE').value;
      p.expect('to');
      validTo = p.expectType('DATE').value;
      p.expect(';');
    } else {
      throw new QError('E_PARSE', `unexpected '${p.peek().value}' in bucket '${name}' at line ${p.peek().line}`);
    }
  }
  p.expect('}');
  if (limit === null) throw new QError('E_PARSE', `bucket '${name}' is missing a limit`);
  return { kind: 'bucket', name, limit, validFrom, validTo };
}

function parseApproval(p) {
  p.expect('approval');
  const name = p.expectType('IDENT').value;
  p.expect('{');
  const node = { kind: 'approval', name, caps: [], lets: [], rules: [], assigns: [], children: [] };
  while (!p.at('}')) {
    const t = p.peek();
    if (t.value === 'cap') {
      p.next();
      const bucket = p.expectType('IDENT').value;
      const amount = p.expectType('NUMBER').value;
      p.expect(';');
      node.caps.push({ bucket, amount });
    } else if (t.value === 'let') {
      p.next();
      const nm = p.expectType('IDENT').value;
      p.expect('=');
      const expr = parseExpr(p, 1);
      p.expect(';');
      node.lets.push({ name: nm, expr });
    } else if (t.value === 'reject') {
      node.rules.push(parseReject(p));
    } else if (t.value === 'approval') {
      node.children.push(parseApproval(p));
    } else if (t.type === 'IDENT' && p.toks[p.pos + 1] && p.toks[p.pos + 1].value === '=') {
      const nm = p.next().value;
      p.expect('=');
      const expr = parseExpr(p, 1);
      p.expect(';');
      node.assigns.push({ name: nm, expr, line: t.line });
    } else {
      throw new QError('E_PARSE', `unexpected '${t.value}' in approval '${name}' at line ${t.line}`);
    }
  }
  p.expect('}');
  return node;
}

function parseReject(p) {
  p.expect('reject');
  const opTok = p.next();
  if (!['freeze', 'unfreeze', 'debit'].includes(opTok.value)) {
    throw new QError('E_PARSE', `reject: unknown op '${opTok.value}' at line ${opTok.line}`);
  }
  p.expect('when');
  const when = parseExpr(p, 1);
  let unless = null;
  if (p.at('unless')) { p.next(); unless = parseExpr(p, 1); }
  let code = 'E_CAP';
  if (p.at('->')) { p.next(); code = p.expectType('IDENT').value; }
  p.expect(';');
  return { kind: 'rule', op: opTok.value, when, unless, code };
}

// Pratt parser: or < and < comparison/matches < additive < multiplicative < unary
const BIN_BP = {
  or: 1, and: 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3, matches: 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5,
};

function parseExpr(p, minBp) {
  const t = p.next();
  let left;
  if (t.type === 'NUMBER') left = { k: 'num', v: t.value };
  else if (t.type === 'STRING') left = { k: 'str', v: t.value };
  else if (t.value === 'true' || t.value === 'false') left = { k: 'bool', v: t.value === 'true' };
  else if (t.value === 'amount') left = { k: 'amount' };
  else if (t.value === 'note') left = { k: 'note' };
  else if (t.value === '(') { left = parseExpr(p, 1); p.expect(')'); }
  else if (t.value === '-') left = { k: 'un', op: 'neg', e: parseExpr(p, 6) };
  else if (t.value === 'not') left = { k: 'un', op: 'not', e: parseExpr(p, 6) };
  else if (['available', 'frozen', 'limit', 'used'].includes(t.value)) {
    p.expect('(');
    const bucket = p.expectType('IDENT').value;
    p.expect(')');
    left = { k: 'call', fn: t.value, bucket };
  } else if (t.type === 'IDENT') left = { k: 'var', name: t.value };
  else throw new QError('E_PARSE', `unexpected '${t.value}' in expression at line ${t.line}`);

  for (;;) {
    const op = p.peek().value;
    const bp = BIN_BP[op];
    if (bp === undefined || bp < minBp) break;
    p.next();
    if (op === 'matches') {
      const re = p.expectType('REGEX');
      left = { k: 'match', left, re: re.value };
      continue;
    }
    const right = parseExpr(p, bp + 1);
    left = { k: 'bin', op, l: left, r: right };
  }
  return left;
}
