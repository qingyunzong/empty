'use strict';

// Regex AST -> NFA (Thompson) -> DFA (subset construction, total) ->
// minimal DFA (partition refinement) -> canonical serialization.
//
// A DFA is { start, trans: [ { char: stateId } ], accepts: Set<stateId> }.
// DFAs produced here are total over the alphabet they were built with.

function escapeChar(ch) {
  return 'U+' + ch.codePointAt(0).toString(16).padStart(4, '0');
}

class NfaBuilder {
  constructor() {
    this.size = 0;
    this.eps = [];    // eps[state] = [target, ...]
    this.trans = [];  // trans[state] = Map(char -> [target, ...])
  }
  state() {
    const id = this.size++;
    this.eps.push([]);
    this.trans.push(new Map());
    return id;
  }
  addEps(from, to) {
    this.eps[from].push(to);
  }
  addTrans(from, ch, to) {
    const m = this.trans[from];
    const arr = m.get(ch);
    if (arr) arr.push(to);
    else m.set(ch, [to]);
  }
}

function buildFragment(b, ast) {
  switch (ast.type) {
    case 'eps': {
      const s = b.state();
      const e = b.state();
      b.addEps(s, e);
      return { s, e };
    }
    case 'lit': {
      const s = b.state();
      const e = b.state();
      b.addTrans(s, ast.char, e);
      return { s, e };
    }
    case 'cat': {
      const frags = ast.parts.map((p) => buildFragment(b, p));
      for (let i = 0; i + 1 < frags.length; i++) {
        b.addEps(frags[i].e, frags[i + 1].s);
      }
      return { s: frags[0].s, e: frags[frags.length - 1].e };
    }
    case 'alt': {
      const s = b.state();
      const e = b.state();
      for (const branch of ast.branches) {
        const f = buildFragment(b, branch);
        b.addEps(s, f.s);
        b.addEps(f.e, e);
      }
      return { s, e };
    }
    case 'star': {
      const s = b.state();
      const e = b.state();
      const f = buildFragment(b, ast.child);
      b.addEps(s, e);
      b.addEps(s, f.s);
      b.addEps(f.e, f.s);
      b.addEps(f.e, e);
      return { s, e };
    }
    case 'plus': {
      const s = b.state();
      const e = b.state();
      const f = buildFragment(b, ast.child);
      b.addEps(s, f.s);
      b.addEps(f.e, f.s);
      b.addEps(f.e, e);
      return { s, e };
    }
    case 'opt': {
      const s = b.state();
      const e = b.state();
      const f = buildFragment(b, ast.child);
      b.addEps(s, e);
      b.addEps(s, f.s);
      b.addEps(f.e, e);
      return { s, e };
    }
    default:
      throw new Error(`unknown AST node type: ${ast.type}`);
  }
}

// contains=true wraps the union of asts as Sigma* (re1|...|reN) Sigma*.
// contains=false builds the full-match union re1|...|reN.
function buildNfa(asts, alphabet, contains) {
  const b = new NfaBuilder();
  const start = b.state();
  const accept = b.state();
  if (contains) {
    for (const ch of alphabet) {
      b.addTrans(start, ch, start);
      b.addTrans(accept, ch, accept);
    }
  }
  for (const ast of asts) {
    const f = buildFragment(b, ast);
    b.addEps(start, f.s);
    b.addEps(f.e, accept);
  }
  return { start, accepts: new Set([accept]), size: b.size, eps: b.eps, trans: b.trans };
}

function epsilonClosure(nfa, set) {
  const out = new Set(set);
  const stack = [...set];
  while (stack.length) {
    const s = stack.pop();
    for (const t of nfa.eps[s]) {
      if (!out.has(t)) {
        out.add(t);
        stack.push(t);
      }
    }
  }
  return out;
}

// Total DFA over `alphabet` (alphabet must be sorted for deterministic
// state numbering; callers pass sorted arrays).
function determinize(nfa, alphabet) {
  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const startSet = epsilonClosure(nfa, new Set([nfa.start]));
  const ids = new Map([[keyOf(startSet), 0]]);
  const queue = [startSet];
  const trans = [];
  const accepts = new Set();
  for (let qi = 0; qi < queue.length; qi++) {
    const set = queue[qi];
    const id = qi;
    trans[id] = {};
    for (const s of set) {
      if (nfa.accepts.has(s)) {
        accepts.add(id);
        break;
      }
    }
    for (const ch of alphabet) {
      const move = new Set();
      for (const s of set) {
        const targets = nfa.trans[s].get(ch);
        if (targets) for (const t of targets) move.add(t);
      }
      const next = epsilonClosure(nfa, move);
      const k = keyOf(next);
      let tid = ids.get(k);
      if (tid === undefined) {
        tid = queue.length;
        ids.set(k, tid);
        queue.push(next);
      }
      trans[id][ch] = tid;
    }
  }
  return { start: 0, trans, accepts };
}

function minimize(dfa, alphabet) {
  const n = dfa.trans.length;
  let blockOf = new Array(n);
  for (let s = 0; s < n; s++) blockOf[s] = dfa.accepts.has(s) ? 1 : 0;
  let count = new Set(blockOf).size;
  for (;;) {
    const sigMap = new Map();
    const next = new Array(n);
    for (let s = 0; s < n; s++) {
      let sig = (dfa.accepts.has(s) ? 'A' : 'N') + ';' + blockOf[s];
      for (const ch of alphabet) {
        const t = dfa.trans[s][ch];
        sig += '|' + (t === undefined ? -1 : blockOf[t]);
      }
      let id = sigMap.get(sig);
      if (id === undefined) {
        id = sigMap.size;
        sigMap.set(sig, id);
      }
      next[s] = id;
    }
    if (sigMap.size === count) {
      blockOf = next;
      break;
    }
    count = sigMap.size;
    blockOf = next;
  }
  const rep = new Array(count).fill(-1);
  for (let s = 0; s < n; s++) {
    if (rep[blockOf[s]] === -1) rep[blockOf[s]] = s;
  }
  const trans = Array.from({ length: count }, () => ({}));
  const accepts = new Set();
  for (let b = 0; b < count; b++) {
    const s = rep[b];
    if (dfa.accepts.has(s)) accepts.add(b);
    for (const ch of alphabet) {
      const t = dfa.trans[s][ch];
      if (t !== undefined) trans[b][ch] = blockOf[t];
    }
  }
  return { start: blockOf[dfa.start], trans, accepts };
}

function compile(asts, alphabet, contains) {
  const sorted = [...alphabet].sort();
  return minimize(determinize(buildNfa(asts, sorted, contains), sorted), sorted);
}

function compileContains(asts, alphabet) {
  return compile(asts, alphabet, true);
}

function compileFull(asts, alphabet) {
  return compile(asts, alphabet, false);
}

// BFS renumbering from the start state over the sorted alphabet gives a
// canonical string for the (minimal) DFA: equal languages over the same
// alphabet serialize identically.
function canonicalSerialize(dfa, alphabet) {
  const sorted = [...alphabet].sort();
  const newId = new Map([[dfa.start, 0]]);
  const order = [dfa.start];
  for (let qi = 0; qi < order.length; qi++) {
    const s = order[qi];
    for (const ch of sorted) {
      const t = dfa.trans[s][ch];
      if (t === undefined) continue;
      if (!newId.has(t)) {
        newId.set(t, order.length);
        order.push(t);
      }
    }
  }
  const parts = [];
  parts.push('n=' + order.length);
  parts.push('acc=' + order.filter((s) => dfa.accepts.has(s)).map((s) => newId.get(s)).join(','));
  for (const s of order) {
    const i = newId.get(s);
    for (const ch of sorted) {
      const t = dfa.trans[s][ch];
      parts.push(i + ':' + escapeChar(ch) + '>' + (t === undefined ? '-' : newId.get(t)));
    }
  }
  return parts.join(';');
}

// mapChar (optional) translates an input character to an alphabet character.
function runDfa(dfa, s, mapChar) {
  let st = dfa.start;
  for (const ch of s) {
    const c = mapChar ? mapChar(ch) : ch;
    const t = dfa.trans[st][c];
    if (t === undefined) return -1;
    st = t;
  }
  return st;
}

function acceptsString(dfa, s, mapChar) {
  const st = runDfa(dfa, s, mapChar);
  return st !== -1 && dfa.accepts.has(st);
}

// Shortest substring of `s` accepted by a full-match DFA; ties broken by
// lexicographic order. Returns null when no substring matches.
function shortestAcceptedSubstring(dfa, s, mapChar) {
  if (dfa.accepts.has(dfa.start)) return '';
  const n = s.length;
  let bestLen = Infinity;
  let best = null;
  for (let i = 0; i < n; i++) {
    let st = dfa.start;
    for (let j = i; j < n; j++) {
      const c = mapChar ? mapChar(s[j]) : s[j];
      const t = dfa.trans[st][c];
      if (t === undefined) break;
      st = t;
      if (dfa.accepts.has(st)) {
        const len = j - i + 1;
        if (len > bestLen) break;
        const w = s.slice(i, j + 1);
        if (len < bestLen || w < best) {
          bestLen = len;
          best = w;
        }
        break;
      }
    }
  }
  return best;
}

// Shortest string accepted by exactly one of the two DFAs (both total over
// the same alphabet), or null when the languages are equal.
function shortestDistinguishing(d1, d2, alphabet) {
  const sorted = [...alphabet].sort();
  const visited = new Set([d1.start + ',' + d2.start]);
  let frontier = [[d1.start, d2.start, '']];
  while (frontier.length) {
    const next = [];
    for (const [s1, s2, w] of frontier) {
      if (d1.accepts.has(s1) !== d2.accepts.has(s2)) return w;
      for (const ch of sorted) {
        const t1 = d1.trans[s1][ch];
        const t2 = d2.trans[s2][ch];
        const k = t1 + ',' + t2;
        if (!visited.has(k)) {
          visited.add(k);
          next.push([t1, t2, w + ch]);
        }
      }
    }
    frontier = next;
  }
  return null;
}

module.exports = {
  escapeChar,
  compileContains,
  compileFull,
  canonicalSerialize,
  runDfa,
  acceptsString,
  shortestAcceptedSubstring,
  shortestDistinguishing,
};
