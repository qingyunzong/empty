// Minimal, dependency-free interlock expression engine.
// Grammar:
//   or   := and ( '||' and )*
//   and  := not ( '&&' not )*
//   not  := '!' not | cmp
//   cmp  := primary ( ('<'|'<='|'>'|'>='|'=='|'!=') primary )?
//   primary := number | boolean | identifier | '(' or ')'

import { SyncError } from './errors.js';

const TOKEN_RE = /\s*(?:(\d+(?:\.\d+)?)|(true|false)|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||==|!=|<=|>=|[<>()!]))/y;

function tokenize(src) {
  const tokens = [];
  let pos = 0;
  while (pos < src.length) {
    TOKEN_RE.lastIndex = pos;
    const m = TOKEN_RE.exec(src);
    if (!m || m.index !== pos) {
      throw new SyncError('VALIDATION', `interlock parse error at offset ${pos}: ${src}`);
    }
    pos = TOKEN_RE.lastIndex;
    if (m[1] !== undefined) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ t: 'bool', v: m[2] === 'true' });
    else if (m[3] !== undefined) tokens.push({ t: 'ident', v: m[3] });
    else tokens.push({ t: 'op', v: m[4] });
  }
  return tokens;
}

export function parseExpression(src) {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new SyncError('VALIDATION', 'empty interlock expression');
  }
  const tokens = tokenize(src);
  let i = 0;
  const peek = () => tokens[i];
  const eatOp = (op) => {
    if (peek() && peek().t === 'op' && peek().v === op) { i++; return true; }
    return false;
  };

  function parseOr() {
    let left = parseAnd();
    while (eatOp('||')) left = { kind: 'or', left, right: parseAnd() };
    return left;
  }
  function parseAnd() {
    let left = parseNot();
    while (eatOp('&&')) left = { kind: 'and', left, right: parseNot() };
    return left;
  }
  function parseNot() {
    if (eatOp('!')) return { kind: 'not', arg: parseNot() };
    return parseCmp();
  }
  function parseCmp() {
    const left = parsePrimary();
    const tk = peek();
    if (tk && tk.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(tk.v)) {
      i++;
      return { kind: 'cmp', op: tk.v, left, right: parsePrimary() };
    }
    return left;
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new SyncError('VALIDATION', `unexpected end of interlock: ${src}`);
    if (tk.t === 'num') { i++; return { kind: 'num', value: tk.v }; }
    if (tk.t === 'bool') { i++; return { kind: 'bool', value: tk.v }; }
    if (tk.t === 'ident') { i++; return { kind: 'ident', name: tk.v }; }
    if (tk.t === 'op' && tk.v === '(') {
      i++;
      const e = parseOr();
      if (!eatOp(')')) throw new SyncError('VALIDATION', `missing ')' in interlock: ${src}`);
      return e;
    }
    throw new SyncError('VALIDATION', `unexpected token in interlock: ${src}`);
  }

  const ast = parseOr();
  if (i !== tokens.length) throw new SyncError('VALIDATION', `trailing tokens in interlock: ${src}`);
  return ast;
}

export function identifiers(ast, out = new Set()) {
  switch (ast.kind) {
    case 'ident': out.add(ast.name); break;
    case 'not': identifiers(ast.arg, out); break;
    case 'and': case 'or': case 'cmp':
      identifiers(ast.left ?? ast.arg, out);
      if (ast.right) identifiers(ast.right, out);
      break;
    default: break;
  }
  return out;
}

function truthy(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return Boolean(v);
}

export function evaluate(ast, env) {
  switch (ast.kind) {
    case 'num': return ast.value;
    case 'bool': return ast.value;
    case 'ident': {
      if (!(ast.name in env)) {
        throw new SyncError('VALIDATION', `interlock references unknown param: ${ast.name}`);
      }
      return env[ast.name];
    }
    case 'not': return !truthy(evaluate(ast.arg, env));
    case 'and': return truthy(evaluate(ast.left, env)) && truthy(evaluate(ast.right, env));
    case 'or': return truthy(evaluate(ast.left, env)) || truthy(evaluate(ast.right, env));
    case 'cmp': {
      const l = evaluate(ast.left, env);
      const r = evaluate(ast.right, env);
      switch (ast.op) {
        case '<': return l < r;
        case '<=': return l <= r;
        case '>': return l > r;
        case '>=': return l >= r;
        case '==': return l === r;
        case '!=': return l !== r;
        default: throw new SyncError('VALIDATION', `bad comparator ${ast.op}`);
      }
    }
    default: throw new SyncError('VALIDATION', `bad interlock node ${ast.kind}`);
  }
}

// Fail-closed check: returns true when the expression cannot be fully
// evaluated because some referenced params have no value yet.
export function unevaluable(ast, env) {
  for (const name of identifiers(ast)) {
    if (!(name in env) || env[name] === undefined) return true;
  }
  return false;
}
