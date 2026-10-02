import { DslError } from './errors.js';

const VERDICTS = new Set(['ACCEPT', 'REJECT', 'CONTINUE']);
const TYPE_NAMES = new Set(['quantity', 'ratio', 'level', 'date', 'batch']);
const LEVEL_LITERALS = new Set(['minor', 'major', 'critical']);

// Infix binding powers (Pratt). `not` parses its operand at power 2 so that
// `not a == b` means `not (a == b)` while `not a and b` means `(not a) and b`.
const INFIX_BP = {
  or: 1,
  and: 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6,
};

const NOT_OPERAND_BP = 2;
const NEG_OPERAND_BP = 7;

export function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1;
}

export function makeRatio(n, d) {
  if (d === 0) throw new Error('ratio with zero denominator');
  if (d < 0) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function percentToRatio(text) {
  const [whole, frac = ''] = text.split('.');
  const scale = 10 ** frac.length;
  const num = Number(whole) * scale + Number(frac || 0);
  return makeRatio(num, scale * 100);
}

function describe(tok) {
  if (tok.type === 'EOF') return 'end of input';
  if (tok.type === 'IDENT') return `identifier '${tok.value}'`;
  if (tok.type === 'STRING') return `string "${tok.value}"`;
  if (tok.type === 'NUMBER' || tok.type === 'PERCENT' || tok.type === 'DATE' || tok.type === 'BATCH') {
    return `'${tok.value}'`;
  }
  return `'${tok.type}'`;
}

export function parse(tokens, filename = '<input>') {
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = (msg, tok = peek()) => {
    throw new DslError(`${filename}:${tok.line}: ${msg}`, tok.line);
  };
  const expect = (type, what) => {
    const tok = peek();
    if (tok.type !== type) fail(`expected ${what ?? `'${type}'`} but found ${describe(tok)}`, tok);
    pos += 1;
    return tok;
  };
  const accept = (type) => {
    if (peek().type === type) { pos += 1; return tokens[pos - 1]; }
    return null;
  };

  function parseExpr(minBp) {
    const tok = peek();
    let left;
    if (accept('not')) {
      left = { kind: 'un', op: 'not', expr: parseExpr(NOT_OPERAND_BP), line: tok.line };
    } else if (accept('-')) {
      left = { kind: 'un', op: 'neg', expr: parseExpr(NEG_OPERAND_BP), line: tok.line };
    } else if (tok.type === 'NUMBER') {
      pos += 1;
      left = { kind: 'lit', litType: 'quantity', value: Number(tok.value), line: tok.line };
    } else if (tok.type === 'PERCENT') {
      pos += 1;
      left = { kind: 'lit', litType: 'ratio', value: percentToRatio(tok.value), line: tok.line };
    } else if (tok.type === 'DATE') {
      pos += 1;
      left = { kind: 'lit', litType: 'date', value: tok.value, line: tok.line };
    } else if (tok.type === 'BATCH') {
      pos += 1;
      left = { kind: 'lit', litType: 'batch', value: tok.value, line: tok.line };
    } else if (LEVEL_LITERALS.has(tok.type)) {
      pos += 1;
      const levelValue = { minor: 1, major: 2, critical: 3 }[tok.type];
      left = { kind: 'lit', litType: 'level', value: levelValue, line: tok.line };
    } else if (tok.type === 'IDENT') {
      pos += 1;
      left = { kind: 'ident', name: tok.value, line: tok.line };
    } else if (accept('(')) {
      left = parseExpr(0);
      expect(')', "')' to close grouped expression");
    } else {
      fail(`expected an expression but found ${describe(tok)}`, tok);
    }

    for (;;) {
      const op = peek().type;
      const bp = INFIX_BP[op];
      if (bp === undefined || bp <= minBp) break;
      pos += 1;
      const right = parseExpr(bp);
      left = { kind: 'bin', op, left, right, line: tokens[pos - 1].line };
    }
    return left;
  }

  function parseTypeName() {
    const tok = peek();
    if (!TYPE_NAMES.has(tok.type)) fail(`expected a type (quantity|ratio|level|date|batch) but found ${describe(tok)}`, tok);
    pos += 1;
    return tok.type;
  }

  function parseVerdict() {
    const tok = peek();
    if (!VERDICTS.has(tok.type)) fail(`expected a verdict (ACCEPT|REJECT|CONTINUE) but found ${describe(tok)}`, tok);
    pos += 1;
    return tok.type;
  }

  function parseBinding(keyword) {
    const nameTok = expect('IDENT', `a name after '${keyword}'`);
    let declaredType = null;
    if (accept(':')) declaredType = parseTypeName();
    expect('=', `'=' in ${keyword} declaration`);
    const expr = parseExpr(0);
    return { name: nameTok.value, declaredType, expr, line: nameTok.line };
  }

  // ---- rule header ----
  const ruleTok = expect('rule', "'rule' at the start of the file");
  const name = expect('STRING', 'a rule name string').value;
  expect('version', "'version' after the rule name");
  const ruleVersion = Number(expect('NUMBER', 'a version number').value);
  expect('{', "'{' to open the rule body");

  const params = [];
  const consts = [];
  const clauses = [];
  let otherwise = null;

  while (peek().type !== '}') {
    const tok = peek();
    if (accept('param')) {
      const nameTok = expect('IDENT', 'a parameter name');
      expect(':', "':' after parameter name");
      const type = parseTypeName();
      params.push({ name: nameTok.value, type, line: nameTok.line });
    } else if (accept('const')) {
      consts.push(parseBinding('const'));
    } else if (accept('when')) {
      const lets = [];
      if (accept('let')) {
        for (;;) {
          lets.push(parseBinding('let'));
          if (!accept(',')) break;
        }
        expect('in', "'in' after let bindings");
      }
      const cond = parseExpr(0);
      expect('=>', "'=>' before the verdict");
      const verdict = parseVerdict();
      clauses.push({ lets, cond, verdict, line: tok.line });
    } else if (accept('otherwise')) {
      if (otherwise) fail("duplicate 'otherwise' clause", tok);
      expect('=>', "'=>' before the verdict");
      otherwise = { verdict: parseVerdict(), line: tok.line };
    } else {
      fail(`expected 'param', 'const', 'when' or 'otherwise' but found ${describe(tok)}`, tok);
    }
  }
  expect('}');
  expect('EOF', 'end of input after the rule body');

  if (clauses.length === 0 && !otherwise) {
    fail('rule must contain at least one \'when\' clause or an \'otherwise\' verdict', ruleTok);
  }

  return { name, ruleVersion, params, consts, clauses, otherwise };
}
