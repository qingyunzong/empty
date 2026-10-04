import { createHash } from 'node:crypto';

export class GateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GateError';
    this.code = code;
  }
}

const KEYWORDS = new Set(['and', 'or', 'not', 'null', 'true', 'false', 'over', 'is']);
const NUM_RE = /[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const ID_RE = /[A-Za-z_][A-Za-z0-9_]*/y;

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    NUM_RE.lastIndex = i;
    const num = NUM_RE.exec(src);
    if (num) {
      tokens.push({ k: 'num', v: num[0], num: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          out += src[j + 1];
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      if (j >= src.length) throw new GateError('E_RULE', 'unterminated string literal');
      tokens.push({ k: 'str', v: out, str: out });
      i = j + 1;
      continue;
    }
    ID_RE.lastIndex = i;
    const id = ID_RE.exec(src);
    if (id) {
      const word = id[0];
      tokens.push(KEYWORDS.has(word) ? { k: 'kw', v: word } : { k: 'id', v: word });
      i += word.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') {
      tokens.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    if ('<>+-*/%,()'.includes(ch)) {
      tokens.push({ k: 'op', v: ch });
      i++;
      continue;
    }
    if (ch === '=') throw new GateError('E_RULE', "use '==' for equality, not '='");
    throw new GateError('E_RULE', `unexpected character '${ch}'`);
  }
  return tokens;
}

export function parse(src) {
  if (typeof src !== 'string' || !src.trim()) throw new GateError('E_RULE', 'empty expression');
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expect = (v) => {
    const t = take();
    if (!t || t.v !== v) {
      throw new GateError('E_RULE', `expected '${v}' but found ${t ? `'${t.v}'` : 'end of expression'}`);
    }
  };
  const parseOr = () => {
    let l = parseAnd();
    while (peek()?.v === 'or') {
      take();
      l = { t: 'bin', op: 'or', l, r: parseAnd() };
    }
    return l;
  };
  const parseAnd = () => {
    let l = parseNot();
    while (peek()?.v === 'and') {
      take();
      l = { t: 'bin', op: 'and', l, r: parseNot() };
    }
    return l;
  };
  const parseNot = () => {
    if (peek()?.v === 'not') {
      take();
      return { t: 'un', op: 'not', a: parseNot() };
    }
    return parseCmp();
  };
  const parseCmp = () => {
    const l = parseAdd();
    const t = peek();
    if (t && (t.v === '==' || t.v === '!=' || t.v === '<' || t.v === '<=' || t.v === '>' || t.v === '>=')) {
      take();
      return { t: 'bin', op: t.v, l, r: parseAdd() };
    }
    if (t?.v === 'is') {
      take();
      let neg = false;
      if (peek()?.v === 'not') {
        take();
        neg = true;
      }
      expect('null');
      return { t: 'isnull', a: l, neg };
    }
    return l;
  };
  const parseAdd = () => {
    let l = parseMul();
    while (peek()?.v === '+' || peek()?.v === '-') {
      const op = take().v;
      l = { t: 'bin', op, l, r: parseMul() };
    }
    return l;
  };
  const parseMul = () => {
    let l = parseUnary();
    while (peek()?.v === '*' || peek()?.v === '/' || peek()?.v === '%') {
      const op = take().v;
      l = { t: 'bin', op, l, r: parseUnary() };
    }
    return l;
  };
  const parseUnary = () => {
    if (peek()?.v === '-') {
      take();
      return { t: 'un', op: '-', a: parseUnary() };
    }
    return parsePrimary();
  };
  const parsePrimary = () => {
    const t = take();
    if (!t) throw new GateError('E_RULE', 'unexpected end of expression');
    if (t.k === 'num') return { t: 'lit', v: t.num };
    if (t.k === 'str') return { t: 'lit', v: t.str };
    if (t.v === '(') {
      const e = parseOr();
      expect(')');
      return e;
    }
    if (t.k === 'kw') {
      if (t.v === 'null') return { t: 'lit', v: null };
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      throw new GateError('E_RULE', `unexpected keyword '${t.v}'`);
    }
    if (t.k === 'id') {
      if (peek()?.v === '(') {
        take();
        const arg = parseOr();
        expect(')');
        let win = null;
        if (peek()?.v === 'over') {
          take();
          const w = take();
          if (!w || w.k !== 'id') throw new GateError('E_RULE', "expected window name after 'over'");
          win = w.v;
        }
        return { t: 'agg', fn: t.v, arg, win };
      }
      return { t: 'id', name: t.v };
    }
    throw new GateError('E_RULE', `unexpected token '${t.v}'`);
  };
  const ast = parseOr();
  if (pos !== tokens.length) throw new GateError('E_RULE', `unexpected token '${tokens[pos].v}'`);
  return ast;
}

export function walk(node, fn) {
  fn(node);
  switch (node.t) {
    case 'un':
      walk(node.a, fn);
      break;
    case 'bin':
      walk(node.l, fn);
      walk(node.r, fn);
      break;
    case 'isnull':
      walk(node.a, fn);
      break;
    case 'agg':
      walk(node.arg, fn);
      break;
    default:
      break;
  }
}

export function toBool(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  return null;
}

function logicAnd(a, b) {
  const x = toBool(a);
  const y = toBool(b);
  if (x === false || y === false) return false;
  if (x === null || y === null) return null;
  return true;
}

function logicOr(a, b) {
  const x = toBool(a);
  const y = toBool(b);
  if (x === true || y === true) return true;
  if (x === null || y === null) return null;
  return false;
}

function logicNot(a) {
  const x = toBool(a);
  return x === null ? null : !x;
}

function arith(op, l, r) {
  if (l === null || r === null) return null;
  if (typeof l !== 'number' || typeof r !== 'number') return null;
  switch (op) {
    case '+':
      return l + r;
    case '-':
      return l - r;
    case '*':
      return l * r;
    case '/':
      return r === 0 ? null : l / r;
    case '%':
      return r === 0 ? null : l % r;
    default:
      return null;
  }
}

function compare(op, l, r) {
  if (l === null || r === null) return null;
  if (typeof l !== typeof r) return null;
  const t = typeof l;
  if (t !== 'number' && t !== 'string' && t !== 'boolean') return null;
  switch (op) {
    case '==':
      return l === r;
    case '!=':
      return l !== r;
    case '<':
      return t === 'boolean' ? null : l < r;
    case '<=':
      return t === 'boolean' ? null : l <= r;
    case '>':
      return t === 'boolean' ? null : l > r;
    case '>=':
      return t === 'boolean' ? null : l >= r;
    default:
      return null;
  }
}

export function evaluate(node, env, agg) {
  switch (node.t) {
    case 'lit':
      return node.v;
    case 'id':
      return Object.hasOwn(env, node.name) ? env[node.name] : null;
    case 'un': {
      const a = evaluate(node.a, env, agg);
      if (node.op === 'not') return logicNot(a);
      if (a === null) return null;
      return typeof a === 'number' ? -a : null;
    }
    case 'bin': {
      if (node.op === 'and') return logicAnd(evaluate(node.l, env, agg), evaluate(node.r, env, agg));
      if (node.op === 'or') return logicOr(evaluate(node.l, env, agg), evaluate(node.r, env, agg));
      const l = evaluate(node.l, env, agg);
      const r = evaluate(node.r, env, agg);
      if (node.op === '+' || node.op === '-' || node.op === '*' || node.op === '/' || node.op === '%') {
        return arith(node.op, l, r);
      }
      return compare(node.op, l, r);
    }
    case 'isnull': {
      const is = evaluate(node.a, env, agg) === null;
      return node.neg ? !is : is;
    }
    case 'agg': {
      if (!agg) throw new GateError('E_RULE', 'aggregate not allowed in this context');
      return agg(node);
    }
    default:
      throw new GateError('E_RULE', `cannot evaluate node type '${node.t}'`);
  }
}

export function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`;
}

export function hashAst(node) {
  return createHash('sha256').update(stable(node)).digest('hex');
}
