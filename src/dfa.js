'use strict';

// Regex subset -> Thompson NFA -> DFA (subset construction over atomic
// char intervals). Supported syntax: literals, '.', char classes [a-z],
// negated classes [^...], escapes (\d \D \w \W \s \S \n \t \r and escaped
// literals), alternation '|', grouping '(...)' / '(?:...)', and
// quantifiers '*', '+', '?', '{m}', '{m,}', '{m,n}' (optional lazy '?' is
// accepted and ignored: matching is leftmost-longest by construction).

const MAX_CODE = 0xffff;
const MAX_REPEAT = 1000;

class RegexSyntaxError extends Error {
  constructor(msg) {
    super(`regex syntax: ${msg}`);
    this.code = 'BAD_RULE';
  }
}

function parseRegex(src) {
  let pos = 0;
  const peek = () => src[pos];
  const isDigit = (c) => c >= '0' && c <= '9';

  function parseAlt() {
    const branches = [parseConcat()];
    while (peek() === '|') {
      pos++;
      branches.push(parseConcat());
    }
    return branches.length === 1 ? branches[0] : { type: 'alt', branches };
  }

  function parseConcat() {
    const items = [];
    while (pos < src.length && peek() !== '|' && peek() !== ')') {
      items.push(parseRepeat());
    }
    if (items.length === 0) return { type: 'eps' };
    return items.length === 1 ? items[0] : { type: 'cat', items };
  }

  function parseRepeat() {
    let atom = parseAtom();
    for (;;) {
      const c = peek();
      if (c === '*') { pos++; atom = { type: 'rep', atom, min: 0, max: Infinity }; }
      else if (c === '+') { pos++; atom = { type: 'rep', atom, min: 1, max: Infinity }; }
      else if (c === '?') { pos++; atom = { type: 'rep', atom, min: 0, max: 1 }; }
      else if (c === '{') {
        const m = /^\{(\d+)(?:,(\d*))?\}/.exec(src.slice(pos));
        if (!m) break;
        pos += m[0].length;
        const lo = Number(m[1]);
        const hi = m[2] === undefined ? lo : (m[2] === '' ? Infinity : Number(m[2]));
        if (lo > MAX_REPEAT || (hi !== Infinity && (hi > MAX_REPEAT || hi < lo))) {
          throw new RegexSyntaxError('bad repeat bounds');
        }
        atom = { type: 'rep', atom, min: lo, max: hi };
      } else break;
      if (peek() === '?') pos++; // lazy modifier: ignored (longest match)
    }
    return atom;
  }

  function parseAtom() {
    const c = peek();
    if (c === undefined) throw new RegexSyntaxError('unexpected end');
    if (c === '(') {
      pos++;
      if (src.startsWith('?:', pos)) pos += 2;
      const inner = parseAlt();
      if (peek() !== ')') throw new RegexSyntaxError('unclosed group');
      pos++;
      return inner;
    }
    if (c === '[') return parseClass();
    if (c === '.') { pos++; return { type: 'class', ranges: [[0, MAX_CODE]], negated: false }; }
    if (c === '\\') { pos++; return parseEscape(false); }
    if (c === '*' || c === '+' || c === '?' || c === ')') {
      throw new RegexSyntaxError(`unexpected '${c}'`);
    }
    pos++;
    return { type: 'char', code: c.charCodeAt(0) };
  }

  function parseEscape(inClass) {
    const c = src[pos];
    if (c === undefined) throw new RegexSyntaxError('trailing backslash');
    pos++;
    switch (c) {
      case 'd': return { type: 'class', ranges: [[48, 57]], negated: false };
      case 'D': return { type: 'class', ranges: [[48, 57]], negated: true };
      case 'w': return { type: 'class', ranges: [[48, 57], [65, 90], [95, 95], [97, 122]], negated: false };
      case 'W': return { type: 'class', ranges: [[48, 57], [65, 90], [95, 95], [97, 122]], negated: true };
      case 's': return { type: 'class', ranges: [[9, 13], [32, 32]], negated: false };
      case 'S': return { type: 'class', ranges: [[9, 13], [32, 32]], negated: true };
      case 'n': return { type: 'char', code: 10 };
      case 't': return { type: 'char', code: 9 };
      case 'r': return { type: 'char', code: 13 };
      case 'f': return { type: 'char', code: 12 };
      case 'v': return { type: 'char', code: 11 };
      case '0': return { type: 'char', code: 0 };
      default: return { type: 'char', code: c.charCodeAt(0) };
    }
  }

  function parseClass() {
    pos++; // consume '['
    let negated = false;
    if (peek() === '^') { negated = true; pos++; }
    const ranges = [];
    let first = true;
    for (;;) {
      const c = peek();
      if (c === undefined) throw new RegexSyntaxError('unclosed class');
      if (c === ']' && !first) { pos++; break; }
      first = false;
      let lo;
      if (c === '\\') {
        pos++;
        const e = parseEscape(true);
        if (e.type === 'class') {
          for (const r of (e.negated ? negateRanges(e.ranges) : e.ranges)) ranges.push(r);
          continue;
        }
        lo = e.code;
      } else {
        pos++;
        lo = c.charCodeAt(0);
      }
      if (peek() === '-' && src[pos + 1] !== ']' && src[pos + 1] !== undefined) {
        pos++; // consume '-'
        let hi;
        if (peek() === '\\') {
          pos++;
          const e = parseEscape(true);
          if (e.type !== 'char') throw new RegexSyntaxError('bad class range');
          hi = e.code;
        } else {
          hi = src[pos].charCodeAt(0);
          pos++;
        }
        if (hi < lo) throw new RegexSyntaxError('inverted class range');
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    return { type: 'class', ranges, negated };
  }

  const ast = parseAlt();
  if (pos !== src.length) throw new RegexSyntaxError(`unexpected '${peek()}'`);
  return ast;
}

function negateRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  let cur = 0;
  for (const [lo, hi] of sorted) {
    if (lo > cur) out.push([cur, lo - 1]);
    cur = Math.max(cur, hi + 1);
  }
  if (cur <= MAX_CODE) out.push([cur, MAX_CODE]);
  return out;
}

function buildNFA(ast) {
  const edges = []; // {from,to,lo,hi}; lo === -1 means epsilon
  let count = 0;
  const newState = () => count++;
  const eps = (from, to) => edges.push({ from, to, lo: -1, hi: -1 });

  function emit(node) {
    switch (node.type) {
      case 'eps': {
        const s = newState(), a = newState();
        eps(s, a);
        return { start: s, accept: a };
      }
      case 'char': {
        const s = newState(), a = newState();
        edges.push({ from: s, to: a, lo: node.code, hi: node.code });
        return { start: s, accept: a };
      }
      case 'class': {
        const s = newState(), a = newState();
        const ranges = node.negated ? negateRanges(node.ranges) : node.ranges;
        for (const [lo, hi] of ranges) edges.push({ from: s, to: a, lo, hi });
        return { start: s, accept: a };
      }
      case 'cat': {
        let frag = null;
        for (const item of node.items) {
          const f = emit(item);
          if (!frag) frag = f;
          else { eps(frag.accept, f.start); frag = { start: frag.start, accept: f.accept }; }
        }
        return frag || emit({ type: 'eps' });
      }
      case 'alt': {
        const s = newState(), a = newState();
        for (const b of node.branches) {
          const f = emit(b);
          eps(s, f.start);
          eps(f.accept, a);
        }
        return { start: s, accept: a };
      }
      case 'rep': return emitRep(node);
      default: throw new RegexSyntaxError(`unknown node ${node.type}`);
    }
  }

  function emitRep({ atom, min, max }) {
    const frags = [];
    for (let i = 0; i < min; i++) frags.push(emit(atom));
    if (max === Infinity) {
      const s = newState(), a = newState();
      const f = emit(atom);
      eps(s, f.start);
      eps(s, a);
      eps(f.accept, f.start);
      eps(f.accept, a);
      frags.push({ start: s, accept: a });
    } else {
      const s = newState(), a = newState();
      let cur = s;
      for (let i = min; i < max; i++) {
        const f = emit(atom);
        eps(cur, f.start); // take one more
        eps(cur, a);       // or stop here
        cur = f.accept;
      }
      eps(cur, a);
      frags.push({ start: s, accept: a });
    }
    let frag = frags[0];
    for (let i = 1; i < frags.length; i++) {
      eps(frag.accept, frags[i].start);
      frag = { start: frag.start, accept: frags[i].accept };
    }
    return frag;
  }

  const { start, accept } = emit(ast);
  return { count, edges, start, accept };
}

function compileDFA(nfa) {
  const { count, edges, start, accept } = nfa;
  const epsOut = Array.from({ length: count }, () => []);
  const rangeOut = Array.from({ length: count }, () => []);
  const bounds = new Set([0, MAX_CODE + 1]);
  for (const e of edges) {
    if (e.lo === -1) epsOut[e.from].push(e.to);
    else {
      rangeOut[e.from].push(e);
      bounds.add(e.lo);
      bounds.add(e.hi + 1);
    }
  }
  const sortedBounds = [...bounds].sort((a, b) => a - b);
  const intervals = [];
  for (let i = 0; i + 1 < sortedBounds.length; i++) {
    if (sortedBounds[i] < sortedBounds[i + 1]) {
      intervals.push([sortedBounds[i], sortedBounds[i + 1] - 1]);
    }
  }

  function closure(set) {
    const stack = [...set];
    const out = new Set(set);
    while (stack.length) {
      const s = stack.pop();
      for (const t of epsOut[s]) {
        if (!out.has(t)) { out.add(t); stack.push(t); }
      }
    }
    return out;
  }

  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const trans = [];   // per dfa state: [[lo, hi, next], ...] sorted by lo
  const accepting = [];
  const ids = new Map();
  const work = [];

  function intern(set) {
    const key = keyOf(set);
    let id = ids.get(key);
    if (id === undefined) {
      id = trans.length;
      ids.set(key, id);
      trans.push(null);
      accepting.push(set.has(accept));
      work.push([id, set]);
    }
    return id;
  }

  intern(closure(new Set([start])));
  while (work.length) {
    const [id, set] = work.pop();
    const row = [];
    for (const [lo, hi] of intervals) {
      const move = new Set();
      for (const s of set) {
        for (const e of rangeOut[s]) {
          if (e.lo <= lo && e.hi >= lo) {
            for (const t of closure(new Set([e.to]))) move.add(t);
          }
        }
      }
      if (move.size === 0) continue;
      const next = intern(move);
      const last = row[row.length - 1];
      if (last && last[2] === next && last[1] === lo - 1) last[1] = hi;
      else row.push([lo, hi, next]);
    }
    trans[id] = row;
  }
  return { trans, accepting, stateCount: trans.length };
}

class RegexDFA {
  constructor(pattern) {
    this.pattern = pattern;
    const ast = parseRegex(pattern);
    const dfa = compileDFA(buildNFA(ast));
    this.trans = dfa.trans;
    this.accepting = dfa.accepting;
    this.stateCount = dfa.stateCount;
  }

  // Longest match anchored at position i. Returns {length, trace} where
  // trace[k] is the DFA state after consuming k chars (trace[0] is the
  // start state). Returns null when no non-empty match exists at i.
  matchFrom(text, i) {
    let state = 0;
    const trace = [0];
    let best = 0;
    for (let j = i; j < text.length; j++) {
      const c = text.charCodeAt(j);
      const row = this.trans[state];
      let next = -1;
      for (let k = 0; k < row.length; k++) {
        if (c >= row[k][0] && c <= row[k][1]) { next = row[k][2]; break; }
      }
      if (next === -1) break;
      state = next;
      trace.push(state);
      if (this.accepting[state]) best = j - i + 1;
    }
    if (best < 1) return null;
    return { length: best, trace: trace.slice(0, best + 1) };
  }
}

module.exports = { RegexDFA, parseRegex, RegexSyntaxError };
