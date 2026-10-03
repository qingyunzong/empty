import { CncError, E } from './errors.js';

function stripComments(line) {
  let out = '';
  let depth = 0;
  for (const ch of line) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')' && depth > 0) { depth--; continue; }
    if (ch === ';' && depth === 0) break;
    if (depth === 0) out += ch;
  }
  return out;
}

function tokenizeExpr(src) {
  const compact = src.replace(/\s+/g, '');
  const tokens = [];
  let i = 0;
  while (i < compact.length) {
    const rest = compact.slice(i);
    let m = rest.match(/^#(\d+)/);
    if (m) { tokens.push({ t: 'var', n: Number(m[1]) }); i += m[0].length; continue; }
    m = rest.match(/^\d+(?:\.\d+)?/);
    if (m) { tokens.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
    if ('()+-*/'.includes(rest[0])) { tokens.push({ t: rest[0] }); i += 1; continue; }
    throw new CncError(E.FORMAT, `bad expression: ${src}`);
  }
  return tokens;
}

export function parseExpr(src) {
  const tokens = tokenizeExpr(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const fail = () => { throw new CncError(E.FORMAT, `bad expression: ${src}`); };
  function parseAdd() {
    let node = parseTerm();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = tokens[pos++].t;
      node = { t: 'bin', op, l: node, r: parseTerm() };
    }
    return node;
  }
  function parseTerm() {
    let node = parseUnary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = tokens[pos++].t;
      node = { t: 'bin', op, l: node, r: parseUnary() };
    }
    return node;
  }
  function parseUnary() {
    if (peek() && peek().t === '-') { pos++; return { t: 'neg', e: parseUnary() }; }
    return parseAtom();
  }
  function parseAtom() {
    const tok = peek();
    if (!tok) fail();
    if (tok.t === 'num') { pos++; return { t: 'num', v: tok.v }; }
    if (tok.t === 'var') { pos++; return { t: 'var', n: tok.n }; }
    if (tok.t === '(') {
      pos++;
      const node = parseAdd();
      if (!peek() || peek().t !== ')') fail();
      pos++;
      return node;
    }
    fail();
  }
  const ast = parseAdd();
  if (pos !== tokens.length) fail();
  return ast;
}

export function evalExpr(node, vars) {
  switch (node.t) {
    case 'num': return node.v;
    case 'var': return vars.get(node.n) ?? 0;
    case 'neg': return -evalExpr(node.e, vars);
    case 'bin': {
      const l = evalExpr(node.l, vars);
      const r = evalExpr(node.r, vars);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
      }
    }
  }
  throw new CncError(E.FORMAT, 'bad expression node');
}

function parseWords(rest) {
  const words = {};
  const re = /([A-Z])(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(rest))) words[m[1]] = Number(m[2]);
  return words;
}

export function parseLine(line) {
  const text = stripComments(line).trim().toUpperCase();
  if (!text || text === '%') return { op: 'nop' };
  let label = null;
  let rest = text;
  const lm = rest.match(/^N(\d+)\s*/);
  if (lm) {
    label = Number(lm[1]);
    rest = rest.slice(lm[0].length).trim();
  }
  let stmt;
  let m;
  if (!rest) stmt = { op: 'nop' };
  else if ((m = rest.match(/^O([A-Z0-9_]+)$/))) stmt = { op: 'sub', name: m[1] };
  else if ((m = rest.match(/^M98\s+P([A-Z0-9_]+)$/))) stmt = { op: 'call', name: m[1] };
  else if (/^M99$/.test(rest)) stmt = { op: 'ret' };
  else if (/^M30$/.test(rest) || /^M0?2$/.test(rest)) stmt = { op: 'end' };
  else if ((m = rest.match(/^IF\s*\[(.+)\]\s*GOTO\s*(\d+)$/))) {
    const cm = m[1].match(/^(.*?)\s*(EQ|NE|GT|LT|GE|LE)\s*(.*?)$/);
    if (!cm) throw new CncError(E.FORMAT, `bad condition: ${m[1]}`);
    stmt = { op: 'ifgoto', left: parseExpr(cm[1]), cmp: cm[2], right: parseExpr(cm[3]), target: Number(m[2]) };
  } else if ((m = rest.match(/^GOTO\s*(\d+)$/))) stmt = { op: 'goto', target: Number(m[1]) };
  else if ((m = rest.match(/^#(\d+)\s*=\s*(.+)$/))) stmt = { op: 'assign', var: Number(m[1]), expr: parseExpr(m[2]) };
  else {
    const words = parseWords(rest);
    if (words.G === 0 || words.G === 1) {
      const coords = {};
      for (const k of ['X', 'Y', 'Z']) if (words[k] !== undefined) coords[k] = words[k];
      stmt = { op: 'move', g: words.G, coords };
    } else {
      stmt = { op: 'nop' };
    }
  }
  if (label !== null) stmt.label = label;
  return stmt;
}
