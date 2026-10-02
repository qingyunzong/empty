'use strict';
const crypto = require('node:crypto');

class FormulaError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'FormulaError';
    this.kind = kind; // 'lex' | 'parse' | 'type' | 'name' | 'state'
  }
}

// Known functions and their arity. Calling anything else is a type error.
const FUNCTIONS = {
  sqrt: 1, abs: 1, exp: 1, log: 1,
  sin: 1, cos: 1, tan: 1,
  floor: 1, ceil: 1, round: 1,
  min: 2, max: 2, pow: 2, atan2: 2,
};

const UNIT_RE = /^[A-Za-z][A-Za-z0-9*/^.-]*$/;
const EVIDENCE_RE = /^[A-Za-z0-9_-]+$/;

function lex(src) {
  const tokens = [];
  let i = 0;
  const twoCharOps = ['||', '&&', '==', '!=', '<=', '>='];
  const oneCharOps = '<>+-*/(),';
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '[') {
      if (src[i + 1] === '[') {
        const end = src.indexOf(']]', i + 2);
        if (end === -1) {
          throw new FormulaError('lex', `unclosed evidence fragment at offset ${i}`);
        }
        const id = src.slice(i + 2, end);
        if (!EVIDENCE_RE.test(id)) {
          throw new FormulaError('lex', `invalid evidence id "${id}"`);
        }
        tokens.push({ t: 'evidence', v: id });
        i = end + 2;
        continue;
      }
      const end = src.indexOf(']', i + 1);
      if (end === -1) {
        throw new FormulaError('lex', `unclosed unit fragment at offset ${i}`);
      }
      const unit = src.slice(i + 1, end);
      if (!UNIT_RE.test(unit)) {
        throw new FormulaError('lex', `invalid unit "${unit}"`);
      }
      tokens.push({ t: 'unit', v: unit });
      i = end + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_]\w*/.exec(src.slice(i));
      tokens.push({ t: 'ident', v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (twoCharOps.includes(two)) {
      tokens.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (oneCharOps.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i += 1;
      continue;
    }
    throw new FormulaError('lex', `unexpected character "${c}" at offset ${i}`);
  }
  return tokens;
}

// Binding powers: || < && < comparisons < + - < * / < unary - < call/unit/evidence
const BINARY_BP = {
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3,
  '+': 4, '-': 4,
  '*': 5, '/': 5,
};
const UNARY_BP = 6;

function describeToken(tok) {
  if (!tok) return '<end of input>';
  if (tok.t === 'op') return `"${tok.v}"`;
  if (tok.t === 'unit') return `[${tok.v}]`;
  if (tok.t === 'evidence') return `[[${tok.v}]]`;
  return `"${tok.v}"`;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek() { return this.tokens[this.pos]; }
  advance() { return this.tokens[this.pos++]; }

  parse() {
    const expr = this.parseExpr(1);
    const rest = this.peek();
    if (rest !== undefined) {
      throw new FormulaError('parse', `unexpected token ${describeToken(rest)}`);
    }
    return expr;
  }

  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const tok = this.peek();
      if (tok === undefined) break;
      // Postfix operators bind tightest.
      if (tok.t === 'op' && tok.v === '(') { left = this.parseCall(left); continue; }
      if (tok.t === 'unit') { this.advance(); left = { t: 'unit', unit: tok.v, expr: left }; continue; }
      if (tok.t === 'evidence') { this.advance(); left = { t: 'evidence', id: tok.v, expr: left }; continue; }
      if (tok.t === 'op' && Object.hasOwn(BINARY_BP, tok.v)) {
        const bp = BINARY_BP[tok.v];
        if (bp < minBp) break;
        this.advance();
        const right = this.parseExpr(bp + 1); // left-associative
        left = { t: 'bin', op: tok.v, left, right };
        continue;
      }
      break;
    }
    return left;
  }

  parsePrefix() {
    const tok = this.advance();
    if (tok === undefined) throw new FormulaError('parse', 'unexpected end of expression');
    if (tok.t === 'num') return { t: 'num', v: tok.v };
    if (tok.t === 'ident') return { t: 'name', v: tok.v };
    if (tok.t === 'op' && tok.v === '-') {
      return { t: 'neg', arg: this.parseExpr(UNARY_BP) };
    }
    if (tok.t === 'op' && tok.v === '(') {
      const inner = this.parseExpr(1);
      const close = this.advance();
      if (!close || close.t !== 'op' || close.v !== ')') {
        throw new FormulaError('parse', 'expected ")"');
      }
      return inner;
    }
    throw new FormulaError('parse', `unexpected token ${describeToken(tok)}`);
  }

  parseCall(callee) {
    if (callee.t !== 'name') {
      throw new FormulaError('type', 'only named functions can be called');
    }
    this.advance(); // consume '('
    const args = [];
    const first = this.peek();
    if (first && first.t === 'op' && first.v === ')') {
      this.advance();
    } else {
      for (;;) {
        args.push(this.parseExpr(1));
        const sep = this.advance();
        if (sep && sep.t === 'op' && sep.v === ',') continue;
        if (sep && sep.t === 'op' && sep.v === ')') break;
        throw new FormulaError('parse', 'expected "," or ")" in call arguments');
      }
    }
    const arity = FUNCTIONS[callee.v];
    if (arity === undefined) {
      throw new FormulaError('type', `unknown function "${callee.v}"`);
    }
    if (args.length !== arity) {
      throw new FormulaError('type', `function "${callee.v}" expects ${arity} argument(s), got ${args.length}`);
    }
    return { t: 'call', fn: callee.v, args };
  }
}

function parse(src) {
  return new Parser(lex(src)).parse();
}

// Canonical serialization of an AST: fully determined by structure, no
// whitespace or formatting variance.
function canonical(node) {
  switch (node.t) {
    case 'num': return `num(${node.v})`;
    case 'name': return `name(${node.v})`;
    case 'neg': return `neg(${canonical(node.arg)})`;
    case 'bin': return `bin(${node.op},${canonical(node.left)},${canonical(node.right)})`;
    case 'call': return `call(${node.fn},${node.args.map(canonical).join(',')})`;
    case 'unit': return `unit(${node.unit},${canonical(node.expr)})`;
    case 'evidence': return `evidence(${node.id},${canonical(node.expr)})`;
    default: throw new FormulaError('type', `cannot canonicalize node type "${node.t}"`);
  }
}

function certificate(name, version, ast) {
  const payload = JSON.stringify({ name, version, ast: canonical(ast) });
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

const NAME_RE = /^[A-Za-z_]\w*$/;

class FormulaStore {
  constructor() {
    this.formulas = new Map(); // name -> { versions: [ast], current: index }
  }

  has(name) { return this.formulas.has(name); }

  _get(name) {
    const entry = this.formulas.get(name);
    if (!entry) throw new FormulaError('name', `unknown formula "${name}"`);
    return entry;
  }

  _checkName(name) {
    if (!NAME_RE.test(name)) throw new FormulaError('name', `invalid formula name "${name}"`);
  }

  def(name, src) {
    this._checkName(name);
    if (this.formulas.has(name)) {
      throw new FormulaError('state', `formula "${name}" is already defined`);
    }
    const ast = parse(src); // parse fully before committing: no partial versions
    this.formulas.set(name, { versions: [ast], current: 0 });
    return { name, version: 1 };
  }

  correct(name, src) {
    const entry = this._get(name);
    const ast = parse(src); // parse fully before committing
    entry.versions.length = entry.current + 1; // a new correction clears the redo branch
    entry.versions.push(ast);
    entry.current += 1;
    return { name, version: entry.current + 1 };
  }

  undo(name) {
    const entry = this._get(name);
    if (entry.current === 0) {
      throw new FormulaError('state', `formula "${name}" has nothing to undo`);
    }
    entry.current -= 1;
    return { name, version: entry.current + 1 };
  }

  redo(name) {
    const entry = this._get(name);
    if (entry.current >= entry.versions.length - 1) {
      throw new FormulaError('state', `formula "${name}" has nothing to redo`);
    }
    entry.current += 1;
    return { name, version: entry.current + 1 };
  }

  certify(name) {
    const entry = this._get(name);
    const version = entry.current + 1;
    return { name, version, sha256: certificate(name, version, entry.versions[entry.current]) };
  }
}

module.exports = { FormulaError, FormulaStore, lex, parse, canonical, certificate, FUNCTIONS };
