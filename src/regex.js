'use strict';

// Regex over event-type tokens. Supported syntax:
//   literal   e.g.  open        (matches an event whose type equals the literal)
//   .                   any event type
//   a b               concatenation (whitespace separated)
//   a|b               alternation
//   a*  a+  a?        repetition / option
//   ( ... )           grouping
//   \x                escapes a special character into a literal
//
// Semantics: the pattern is anchored at the start of the monitored stream.
// The monitor answers, for the observed prefix: has the forbidden sequence
// been fully matched (VIOLATION), can no extension ever match it (SAFE),
// or is the outcome still open (UNKNOWN).

const { MonitorError } = require('./errors');

// Symbol used inside the DFA for "any event type not mentioned in the pattern".
// A JS Symbol so it can never collide with a user event type.
const OTHER = Symbol('OTHER');

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === '|' || c === '*' || c === '+' || c === '?' || c === '.') {
      tokens.push({ t: c });
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= src.length) throw new MonitorError('BAD_PATTERN', 'dangling escape at end of pattern');
      tokens.push({ t: 'lit', v: src[i + 1] });
      i += 2;
      continue;
    }
    let lit = '';
    while (i < src.length && !/[\s()|*+?.\\]/.test(src[i])) {
      lit += src[i];
      i++;
    }
    tokens.push({ t: 'lit', v: lit });
  }
  return tokens;
}

function parse(src) {
  if (typeof src !== 'string' || src.trim() === '') {
    throw new MonitorError('BAD_PATTERN', 'pattern must be a non-empty string');
  }
  const tokens = tokenize(src);
  let pos = 0;

  function peek() { return tokens[pos]; }

  function parseAlt() {
    const opts = [parseConcat()];
    while (peek() && peek().t === '|') {
      pos++;
      opts.push(parseConcat());
    }
    return opts.length === 1 ? opts[0] : { kind: 'alt', opts };
  }

  function parseConcat() {
    const parts = [];
    while (peek() && peek().t !== '|' && peek().t !== ')') parts.push(parseRep());
    if (parts.length === 0) return { kind: 'empty' };
    return parts.length === 1 ? parts[0] : { kind: 'cat', parts };
  }

  function parseRep() {
    let node = parseAtom();
    while (peek() && (peek().t === '*' || peek().t === '+' || peek().t === '?')) {
      const op = tokens[pos].t;
      pos++;
      node = { kind: op === '*' ? 'star' : op === '+' ? 'plus' : 'opt', sub: node };
    }
    return node;
  }

  function parseAtom() {
    const tk = tokens[pos];
    if (!tk) throw new MonitorError('BAD_PATTERN', 'unexpected end of pattern');
    if (tk.t === 'lit') { pos++; return { kind: 'lit', v: tk.v }; }
    if (tk.t === '.') { pos++; return { kind: 'any' }; }
    if (tk.t === '(') {
      pos++;
      const node = parseAlt();
      if (!peek() || peek().t !== ')') throw new MonitorError('BAD_PATTERN', 'missing closing parenthesis');
      pos++;
      return node;
    }
    throw new MonitorError('BAD_PATTERN', `unexpected token "${tk.t}"`);
  }

  const ast = parseAlt();
  if (pos !== tokens.length) throw new MonitorError('BAD_PATTERN', 'unbalanced parentheses in pattern');
  return ast;
}

// Thompson construction. States: { id, eps: [state], sym: [{ lit?, any?, to }] }.
function buildNFA(ast) {
  const states = [];
  function newState() {
    const s = { id: states.length, eps: [], sym: [] };
    states.push(s);
    return s;
  }
  function build(node) {
    switch (node.kind) {
      case 'empty': {
        const a = newState(); const b = newState();
        a.eps.push(b);
        return { s: a, e: b };
      }
      case 'lit': {
        const a = newState(); const b = newState();
        a.sym.push({ lit: node.v, to: b });
        return { s: a, e: b };
      }
      case 'any': {
        const a = newState(); const b = newState();
        a.sym.push({ any: true, to: b });
        return { s: a, e: b };
      }
      case 'cat': {
        let first = null;
        let prevEnd = null;
        for (const part of node.parts) {
          const f = build(part);
          if (!first) first = f.s;
          else prevEnd.eps.push(f.s);
          prevEnd = f.e;
        }
        return { s: first, e: prevEnd };
      }
      case 'alt': {
        const a = newState(); const b = newState();
        for (const opt of node.opts) {
          const f = build(opt);
          a.eps.push(f.s);
          f.e.eps.push(b);
        }
        return { s: a, e: b };
      }
      case 'star': {
        const a = newState(); const b = newState();
        const f = build(node.sub);
        a.eps.push(f.s, b);
        f.e.eps.push(f.s, b);
        return { s: a, e: b };
      }
      case 'plus': {
        const a = newState(); const b = newState();
        const f = build(node.sub);
        a.eps.push(f.s);
        f.e.eps.push(f.s, b);
        return { s: a, e: b };
      }
      case 'opt': {
        const a = newState(); const b = newState();
        const f = build(node.sub);
        a.eps.push(f.s, b);
        f.e.eps.push(b);
        return { s: a, e: b };
      }
      default:
        throw new MonitorError('BAD_PATTERN', `unknown AST node kind: ${node.kind}`);
    }
  }
  const frag = build(ast);
  return { states, start: frag.s, accept: frag.e };
}

function epsilonClosure(stateSet) {
  const out = new Set(stateSet);
  const stack = [...stateSet];
  while (stack.length > 0) {
    const s = stack.pop();
    for (const t of s.eps) {
      if (!out.has(t)) {
        out.add(t);
        stack.push(t);
      }
    }
  }
  return out;
}

// Subset construction with a deterministic state numbering (BFS over a
// fixed-order alphabet), so the same pattern always yields the same DFA ids.
// Accepting states are turned into sinks: a confirmed violation is absorbing.
function buildDFA(pattern) {
  const ast = parse(pattern);
  const nfa = buildNFA(ast);

  const literalSet = new Set();
  for (const st of nfa.states) {
    for (const tr of st.sym) {
      if (tr.lit !== undefined) literalSet.add(tr.lit);
    }
  }
  const literals = [...literalSet].sort();
  const symbols = [...literals, OTHER];

  function move(nfaSet, symbol) {
    const out = new Set();
    for (const st of nfaSet) {
      for (const tr of st.sym) {
        if (tr.any || tr.lit === symbol) out.add(tr.to);
      }
    }
    return epsilonClosure(out);
  }

  const keyOf = (set) => [...set].map((s) => s.id).sort((a, b) => a - b).join(',');

  const dfaStates = []; // { id, nfaSet, accept, trans: {symbol -> id} }
  const byKey = new Map();
  const worklist = [];

  function intern(nfaSet) {
    const key = keyOf(nfaSet);
    let d = byKey.get(key);
    if (!d) {
      d = { id: dfaStates.length, nfaSet, accept: nfaSet.has(nfa.accept), trans: new Map() };
      dfaStates.push(d);
      byKey.set(key, d);
      worklist.push(d);
    }
    return d;
  }

  const start = intern(epsilonClosure(new Set([nfa.start])));
  while (worklist.length > 0) {
    const d = worklist.shift();
    for (const sym of symbols) {
      const target = intern(move(d.nfaSet, sym));
      d.trans.set(sym, target.id);
    }
  }

  // Make accepting states absorbing: violation, once confirmed, is irreversible.
  const acceptIds = [];
  for (const d of dfaStates) {
    if (d.accept) {
      acceptIds.push(d.id);
      for (const sym of symbols) d.trans.set(sym, d.id);
    }
  }

  // Dead states: no path to any accepting state remains.
  const canReachAccept = new Set(acceptIds);
  const reverse = dfaStates.map(() => []);
  for (const d of dfaStates) {
    for (const sym of symbols) reverse[d.trans.get(sym)].push(d.id);
  }
  const stack = [...acceptIds];
  while (stack.length > 0) {
    const id = stack.pop();
    for (const p of reverse[id]) {
      if (!canReachAccept.has(p)) {
        canReachAccept.add(p);
        stack.push(p);
      }
    }
  }
  const dead = new Set();
  for (const d of dfaStates) {
    if (!canReachAccept.has(d.id)) dead.add(d.id);
  }

  const accept = new Set(acceptIds);
  const transTable = dfaStates.map((d) => {
    const row = new Map();
    for (const sym of symbols) row.set(sym, d.trans.get(sym));
    return row;
  });

  return {
    pattern,
    literals: literalSet,
    symbols,
    start: start.id,
    accept,
    dead,
    trans: transTable,
    size: dfaStates.length,
  };
}

function symbolFor(dfa, eventType) {
  return dfa.literals.has(eventType) ? eventType : OTHER;
}

function step(dfa, stateId, eventType) {
  return dfa.trans[stateId].get(symbolFor(dfa, eventType));
}

module.exports = { OTHER, parse, buildDFA, symbolFor, step };
