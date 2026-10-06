'use strict';

// Mini regex engine over an alphabet of event names.
// Syntax: atoms are bare words (event names) or "quoted strings";
// `.` matches any event; `|` alternation; `(...)` grouping;
// postfix `*`, `+`, `?`, `{m}`, `{m,}`, `{m,n}`; whitespace separates atoms.
// The pattern is matched against the whole trace from the beginning
// (prefix semantics): the pattern language IS the set of bad traces.

function tokenize(pattern) {
  const tokens = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === '|' || c === '*' || c === '+' || c === '?') {
      tokens.push({ t: c }); i++; continue;
    }
    if (c === '.') { tokens.push({ t: 'any' }); i++; continue; }
    if (c === '{') {
      const m = /^\{(\d+)(?:,(\d*)?)?\}/.exec(pattern.slice(i));
      if (!m) throw new Error(`bad repeat at offset ${i}`);
      const hasComma = m[0].includes(',');
      const min = Number(m[1]);
      const max = !hasComma ? min : (m[2] === '' || m[2] === undefined ? Infinity : Number(m[2]));
      if (max < min) throw new Error(`bad repeat range at offset ${i}`);
      tokens.push({ t: 'rep', min, max });
      i += m[0].length; continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < pattern.length && pattern[j] !== '"') {
        if (pattern[j] === '\\' && j + 1 < pattern.length) j++;
        out += pattern[j]; j++;
      }
      if (j >= pattern.length) throw new Error('unterminated quote in pattern');
      tokens.push({ t: 'atom', name: out });
      i = j + 1; continue;
    }
    let j = i;
    while (j < pattern.length && !/[\s()|*+?{".]/.test(pattern[j])) j++;
    if (j === i) throw new Error(`unexpected character ${JSON.stringify(c)} at offset ${i}`);
    tokens.push({ t: 'atom', name: pattern.slice(i, j) });
    i = j;
  }
  return tokens;
}

function cloneAst(node) {
  if (node === null || typeof node !== 'object') return node;
  const out = Array.isArray(node) ? [] : {};
  for (const k of Object.keys(node)) out[k] = cloneAst(node[k]);
  return out;
}

function expandRep(node, min, max) {
  let out = null;
  for (let i = 0; i < min; i++) out = out === null ? cloneAst(node) : { k: 'cat', l: out, r: cloneAst(node) };
  if (max === Infinity) {
    const tail = { k: 'star', x: cloneAst(node) };
    out = out === null ? tail : { k: 'cat', l: out, r: tail };
  } else {
    for (let i = min; i < max; i++) out = out === null ? { k: 'opt', x: cloneAst(node) } : { k: 'cat', l: out, r: { k: 'opt', x: cloneAst(node) } };
  }
  return out === null ? { k: 'eps' } : out;
}

function parse(pattern) {
  const tokens = tokenize(pattern);
  let pos = 0;
  const peek = () => tokens[pos];

  function parseAlt() {
    let node = parseConcat();
    while (peek() && peek().t === '|') { pos++; node = { k: 'alt', l: node, r: parseConcat() }; }
    return node;
  }
  function parseConcat() {
    const parts = [];
    while (peek() && peek().t !== ')' && peek().t !== '|') parts.push(parseRep());
    if (parts.length === 0) return { k: 'eps' };
    return parts.reduce((a, b) => ({ k: 'cat', l: a, r: b }));
  }
  function parseRep() {
    let node = parseAtom();
    while (peek() && (peek().t === '*' || peek().t === '+' || peek().t === '?' || peek().t === 'rep')) {
      const tk = tokens[pos++];
      if (tk.t === '*') node = { k: 'star', x: node };
      else if (tk.t === '+') node = { k: 'cat', l: node, r: { k: 'star', x: cloneAst(node) } };
      else if (tk.t === '?') node = { k: 'opt', x: node };
      else node = expandRep(node, tk.min, tk.max);
    }
    return node;
  }
  function parseAtom() {
    const tk = tokens[pos];
    if (!tk) throw new Error('unexpected end of pattern');
    if (tk.t === 'atom') { pos++; return { k: 'atom', name: tk.name }; }
    if (tk.t === 'any') { pos++; return { k: 'any' }; }
    if (tk.t === '(') {
      pos++;
      const n = parseAlt();
      if (!peek() || peek().t !== ')') throw new Error('missing closing parenthesis');
      pos++;
      return n;
    }
    throw new Error(`unexpected token ${JSON.stringify(tk)}`);
  }

  const ast = parseAlt();
  if (pos !== tokens.length) throw new Error('trailing tokens in pattern');
  return ast;
}

function buildNfa(ast) {
  const states = []; // { eps: number[], moves: [{ name: string|null, to: number }] }
  const newState = () => { states.push({ eps: [], moves: [] }); return states.length - 1; };

  function add(node) {
    switch (node.k) {
      case 'eps': {
        const s = newState(); const a = newState();
        states[s].eps.push(a);
        return { s, a };
      }
      case 'atom': {
        const s = newState(); const a = newState();
        states[s].moves.push({ name: node.name, to: a });
        return { s, a };
      }
      case 'any': {
        const s = newState(); const a = newState();
        states[s].moves.push({ name: null, to: a });
        return { s, a };
      }
      case 'cat': {
        const l = add(node.l); const r = add(node.r);
        states[l.a].eps.push(r.s);
        return { s: l.s, a: r.a };
      }
      case 'alt': {
        const s = newState(); const a = newState();
        const l = add(node.l); const r = add(node.r);
        states[s].eps.push(l.s, r.s);
        states[l.a].eps.push(a); states[r.a].eps.push(a);
        return { s, a };
      }
      case 'star': {
        const s = newState(); const a = newState();
        const x = add(node.x);
        states[s].eps.push(x.s, a);
        states[x.a].eps.push(x.s, a);
        return { s, a };
      }
      case 'opt': {
        const s = newState(); const a = newState();
        const x = add(node.x);
        states[s].eps.push(x.s, a);
        states[x.a].eps.push(a);
        return { s, a };
      }
      default:
        throw new Error(`unknown ast node ${node.k}`);
    }
  }

  const { s, a } = add(ast);
  return { states, start: s, accept: a };
}

// On-demand DFA over the (open-ended) alphabet of event names.
class RegexMonitor {
  constructor(pattern) {
    const { states, start, accept } = buildNfa(parse(pattern));
    this.states = states;
    this.accept = accept;
    this.literals = new Set();
    for (const st of states) for (const mv of st.moves) if (mv.name !== null) this.literals.add(mv.name);
    this.initial = this.closureKey([start]);
    this.moveCache = new Map();
    this.reachCache = new Map();
  }

  closure(ids) {
    const seen = new Set(ids);
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop();
      for (const to of this.states[id].eps) {
        if (!seen.has(to)) { seen.add(to); stack.push(to); }
      }
    }
    return seen;
  }

  keyOf(set) {
    return [...set].sort((x, y) => x - y).join(',');
  }

  closureKey(ids) {
    return this.keyOf(this.closure(ids));
  }

  setFromKey(key) {
    if (key === '') return [];
    return key.split(',').map(Number);
  }

  // name === null means "some event name not present as a literal in the pattern"
  move(key, name) {
    const cacheKey = key + '|' + (name === null ? '<OTHER>' : name);
    const hit = this.moveCache.get(cacheKey);
    if (hit !== undefined) return hit;
    const next = new Set();
    for (const id of this.setFromKey(key)) {
      for (const mv of this.states[id].moves) {
        if (mv.name === null || mv.name === name) next.add(mv.to);
      }
    }
    const out = this.closureKey([...next]);
    this.moveCache.set(cacheKey, out);
    return out;
  }

  isAccept(key) {
    return this.setFromKey(key).includes(this.accept);
  }

  // Can an accepting DFA state still be reached, assuming any future event
  // name is possible? Symbols: every literal in the pattern, plus OTHER
  // (a name matching only wildcard transitions).
  canReachAccept(key) {
    const cached = this.reachCache.get(key);
    if (cached !== undefined) return cached;
    const symbols = [...this.literals, null];
    const visited = new Set([key]);
    const queue = [key];
    let result = false;
    while (queue.length && !result) {
      const cur = queue.shift();
      if (this.isAccept(cur)) { result = true; break; }
      for (const sym of symbols) {
        const nxt = this.move(cur, sym);
        if (!visited.has(nxt)) { visited.add(nxt); queue.push(nxt); }
      }
    }
    this.reachCache.set(key, result);
    return result;
  }

  tri(key) {
    if (this.isAccept(key)) return 'VIOLATION';
    return this.canReachAccept(key) ? 'UNKNOWN' : 'SAFE';
  }
}

module.exports = { parse, buildNfa, RegexMonitor };
