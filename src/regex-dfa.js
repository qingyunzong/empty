'use strict';

// Regex subset -> Thompson NFA -> DFA (subset construction).
// Supported: literals, '.', classes [abc] [a-z] [^...], escapes (\d \D \w \W \s \S
// and escaped literals), alternation '|', concatenation, grouping '()',
// quantifiers '*', '+', '?'. Matching semantics: a hit is any substring that
// fully matches the regex.

const { norm, negate, contains, MAX_CP } = require('./charset');

const MAX_DFA_STATES = 20000;

function parseRegex(src) {
  let pos = 0;
  const peek = () => src[pos];
  const take = () => src[pos++];

  function parseEscapeSet(kind) {
    switch (kind) {
      case 'd': return [[48, 57]];
      case 'D': return negate([[48, 57]]);
      case 'w': return norm([[48, 57], [65, 90], [95, 95], [97, 122]]);
      case 'W': return negate(norm([[48, 57], [65, 90], [95, 95], [97, 122]]));
      case 's': return norm([[9, 13], [32, 32]]);
      case 'S': return negate(norm([[9, 13], [32, 32]]));
      default: return null;
    }
  }

  function parseEscape() {
    const c = take();
    if (c === undefined) throw new Error('trailing backslash');
    const set = parseEscapeSet(c);
    if (set) return { t: 'set', set };
    const lit = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', '0': '\0' }[c];
    const ch = lit !== undefined ? lit : c;
    return { t: 'lit', ch };
  }

  function parseClass() {
    take(); // '['
    let neg = false;
    if (peek() === '^') { take(); neg = true; }
    let set = [];
    let first = true;
    while (pos < src.length && (peek() !== ']' || first)) {
      first = false;
      let loSet = null;
      let loCh;
      if (peek() === '\\') {
        take();
        const c = take();
        const s = parseEscapeSet(c);
        if (s) { set = set.concat(s); continue; }
        loCh = { n: '\n', t: '\t', r: '\r' }[c] ?? c;
      } else {
        loCh = take();
      }
      if (peek() === '-' && pos + 1 < src.length && src[pos + 1] !== ']') {
        take(); // '-'
        let hiCh;
        if (peek() === '\\') {
          take();
          const c = take();
          hiCh = { n: '\n', t: '\t', r: '\r' }[c] ?? c;
        } else {
          hiCh = take();
        }
        const a = loCh.codePointAt(0);
        const b = hiCh.codePointAt(0);
        if (b < a) throw new Error('bad range in class');
        set.push([a, b]);
      } else if (loSet) {
        set = set.concat(loSet);
      } else {
        set.push([loCh.codePointAt(0), loCh.codePointAt(0)]);
      }
    }
    if (take() !== ']') throw new Error('unterminated class');
    set = norm(set);
    return { t: 'set', set: neg ? negate(set) : set };
  }

  function parseAtom() {
    const c = peek();
    if (c === undefined) throw new Error('unexpected end of pattern');
    if (c === '(') {
      take();
      const e = parseAlt();
      if (take() !== ')') throw new Error('unbalanced parenthesis');
      return e;
    }
    if (c === '[') return parseClass();
    if (c === '.') { take(); return { t: 'set', set: negate([[10, 10], [13, 13]]) }; }
    if (c === '\\') { take(); return parseEscape(); }
    if (c === '*' || c === '+' || c === '?' || c === '|' || c === ')') {
      throw new Error('unexpected metacharacter: ' + c);
    }
    take();
    return { t: 'lit', ch: c };
  }

  function parseRep() {
    let a = parseAtom();
    while (peek() === '*' || peek() === '+' || peek() === '?') {
      a = { t: 'rep', op: take(), sub: a };
    }
    return a;
  }

  function parseConcat() {
    const parts = [];
    while (pos < src.length && peek() !== ')' && peek() !== '|') parts.push(parseRep());
    if (parts.length === 0) return { t: 'eps' };
    return parts.length === 1 ? parts[0] : { t: 'cat', parts };
  }

  function parseAlt() {
    const parts = [parseConcat()];
    while (peek() === '|') { take(); parts.push(parseConcat()); }
    return parts.length === 1 ? parts[0] : { t: 'alt', parts };
  }

  const ast = parseAlt();
  if (pos !== src.length) throw new Error('unexpected trailing: ' + src.slice(pos));
  return ast;
}

class NFA {
  constructor() {
    this.eps = []; // epsilon targets per state
    this.trans = []; // [ [set, target], ... ] per state
  }
  newState() {
    this.eps.push([]);
    this.trans.push([]);
    return this.eps.length - 1;
  }
}

function astToNFA(ast) {
  const nfa = new NFA();
  function compile(node) {
    const s = nfa.newState();
    const a = nfa.newState();
    switch (node.t) {
      case 'eps':
        nfa.eps[s].push(a);
        break;
      case 'lit': {
        const cp = node.ch.codePointAt(0);
        nfa.trans[s].push([[[cp, cp]], a]);
        break;
      }
      case 'set':
        nfa.trans[s].push([node.set, a]);
        break;
      case 'cat': {
        nfa.eps[s].push(compile(node.parts[0]).start);
        let prevAccept = null;
        let first = true;
        let prevStart = null;
        for (const part of node.parts) {
          const f = compile(part);
          if (first) { nfa.eps[s].push(f.start); first = false; }
          else nfa.eps[prevAccept].push(f.start);
          prevAccept = f.accept;
          prevStart = f.start;
        }
        nfa.eps[prevAccept].push(a);
        break;
      }
      case 'alt':
        for (const part of node.parts) {
          const f = compile(part);
          nfa.eps[s].push(f.start);
          nfa.eps[f.accept].push(a);
        }
        break;
      case 'rep': {
        const f = compile(node.sub);
        if (node.op === '*') {
          nfa.eps[s].push(f.start, a);
          nfa.eps[f.accept].push(f.start, a);
        } else if (node.op === '+') {
          nfa.eps[s].push(f.start);
          nfa.eps[f.accept].push(f.start, a);
        } else { // '?'
          nfa.eps[s].push(f.start, a);
          nfa.eps[f.accept].push(a);
        }
        break;
      }
      default:
        throw new Error('unknown ast node: ' + node.t);
    }
    return { start: s, accept: a };
  }
  const frag = compile(ast);
  return { nfa, start: frag.start, accept: frag.accept };
}

function nfaToDFA(nfa, start, accept) {
  // Atomic partition of the covered char space.
  const bounds = new Set();
  const sets = [];
  for (const transList of nfa.trans) {
    for (const [set] of transList) {
      sets.push(set);
      for (const [lo, hi] of set) {
        bounds.add(lo);
        bounds.add(hi + 1); // may be MAX_CP + 1; used only as an upper boundary
      }
    }
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const classes = []; // [[lo, hi], ...] disjoint, covering union of all sets
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1] - 1;
    if (sets.some((s) => contains(s, lo))) classes.push([lo, hi]);
  }

  function classOf(cp) {
    let lo = 0;
    let hi = classes.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (cp < classes[m][0]) hi = m - 1;
      else if (cp > classes[m][1]) lo = m + 1;
      else return m;
    }
    return -1;
  }

  function epsClosure(states) {
    const seen = new Set(states);
    const stack = [...states];
    while (stack.length) {
      const s = stack.pop();
      for (const t of nfa.eps[s]) {
        if (!seen.has(t)) { seen.add(t); stack.push(t); }
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  const startSet = epsClosure([start]);
  const keyOf = (arr) => arr.join(',');
  const dfaStates = [startSet];
  const ids = new Map([[keyOf(startSet), 0]]);
  const trans = [new Map()];
  const acceptStates = new Set();
  if (startSet.includes(accept)) acceptStates.add(0);
  const queue = [0];
  while (queue.length) {
    const sid = queue.shift();
    const S = dfaStates[sid];
    for (let ci = 0; ci < classes.length; ci++) {
      const rep = classes[ci][0];
      let target = [];
      for (const s of S) {
        for (const [set, t] of nfa.trans[s]) {
          if (contains(set, rep)) target.push(t);
        }
      }
      if (!target.length) continue;
      target = epsClosure(target);
      const key = keyOf(target);
      let tid = ids.get(key);
      if (tid === undefined) {
        if (dfaStates.length >= MAX_DFA_STATES) throw new Error('DFA too large');
        tid = dfaStates.length;
        ids.set(key, tid);
        dfaStates.push(target);
        trans.push(new Map());
        if (target.includes(accept)) acceptStates.add(tid);
        queue.push(tid);
      }
      trans[sid].set(ci, tid);
    }
  }
  return { start: 0, accept: acceptStates, classes, trans, stateCount: dfaStates.length };
}

function compileRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('empty regex');
  const ast = parseRegex(pattern);
  const { nfa, start, accept } = astToNFA(ast);
  return nfaToDFA(nfa, start, accept);
}

function stepDFA(dfa, state, cp) {
  let lo = 0;
  let hi = dfa.classes.length - 1;
  let ci = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cp < dfa.classes[m][0]) hi = m - 1;
    else if (cp > dfa.classes[m][1]) lo = m + 1;
    else { ci = m; break; }
  }
  if (ci < 0) return -1;
  const t = dfa.trans[state].get(ci);
  return t === undefined ? -1 : t;
}

// All (start, end) pairs whose substring fully matches; zero-length excluded.
function scanDFA(dfa, text) {
  const hits = [];
  const n = text.length;
  for (let s = 0; s < n; s++) {
    let st = dfa.start;
    for (let j = s; j < n; j++) {
      const t = stepDFA(dfa, st, text.charCodeAt(j));
      if (t < 0) break;
      st = t;
      if (dfa.accept.has(st)) hits.push({ start: s, end: j + 1 });
    }
  }
  return hits;
}

// State trajectory of the DFA over text[start..end); null if it dies.
function trajectoryDFA(dfa, text, start, end) {
  const states = [dfa.start];
  let st = dfa.start;
  for (let i = start; i < end; i++) {
    st = stepDFA(dfa, st, text.charCodeAt(i));
    if (st < 0) return null;
    states.push(st);
  }
  return states;
}

module.exports = { compileRegex, scanDFA, stepDFA, trajectoryDFA, parseRegex };
