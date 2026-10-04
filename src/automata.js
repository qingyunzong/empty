'use strict';

const { FlowError, parse, literals, EPS, EMPTY } = require('./regex');

// ---------- Thompson NFA ----------
// nfa = { start, finals:Set<number>, edges: Array<Array<{sym:string|null,to:number}>> }
function buildNfa(ast) {
  const edges = [];
  const newState = () => { edges.push([]); return edges.length - 1; };

  function build(n) {
    switch (n.k) {
      case 'empty': {
        const s = newState(); const e = newState();
        return { s, e };
      }
      case 'eps': {
        const s = newState(); const e = newState();
        edges[s].push({ sym: null, to: e });
        return { s, e };
      }
      case 'lit': {
        const s = newState(); const e = newState();
        edges[s].push({ sym: n.v, to: e });
        return { s, e };
      }
      case 'alt': {
        const s = newState(); const e = newState();
        const x = build(n.a); const y = build(n.b);
        edges[s].push({ sym: null, to: x.s }, { sym: null, to: y.s });
        edges[x.e].push({ sym: null, to: e });
        edges[y.e].push({ sym: null, to: e });
        return { s, e };
      }
      case 'cat': {
        const x = build(n.a); const y = build(n.b);
        edges[x.e].push({ sym: null, to: y.s });
        return { s: x.s, e: y.e };
      }
      case 'star': {
        const s = newState(); const e = newState();
        const x = build(n.x);
        edges[s].push({ sym: null, to: x.s }, { sym: null, to: e });
        edges[x.e].push({ sym: null, to: x.s }, { sym: null, to: e });
        return { s, e };
      }
      default: throw new Error(`bad node ${n.k}`);
    }
  }

  const { s, e } = build(ast);
  return { start: s, finals: new Set([e]), edges };
}

// ---------- Subset construction ----------
// dfa = { alphabet:[...], start, finals:Set<number>, trans: Array<Map<string,number>> }
function nfaToDfa(nfa, alphabet) {
  function closure(states) {
    const seen = new Set(states);
    const stack = [...states];
    while (stack.length) {
      const s = stack.pop();
      for (const e of nfa.edges[s]) {
        if (e.sym === null && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  const key = (arr) => arr.join(',');
  const ids = new Map();
  const trans = [];
  const finals = new Set();
  const queue = [];

  const startSet = closure([nfa.start]);
  ids.set(key(startSet), 0);
  queue.push(startSet);

  while (queue.length) {
    const set = queue.shift();
    const id = ids.get(key(set));
    trans[id] = new Map();
    if (set.some((s) => nfa.finals.has(s))) finals.add(id);
    for (const a of alphabet) {
      const next = [];
      for (const s of set) {
        for (const e of nfa.edges[s]) {
          if (e.sym === a) next.push(e.to);
        }
      }
      if (!next.length) continue;
      const cl = closure(next);
      const k = key(cl);
      if (!ids.has(k)) { ids.set(k, trans.length ? ids.size : ids.size); queue.push(cl); }
      trans[id].set(a, ids.get(k));
    }
  }
  return { alphabet: [...alphabet], start: 0, finals, trans };
}

// ---------- Canonical renumbering (BFS from start, alphabet order) ----------
function canonicalize(dfa) {
  const order = [];
  const map = new Map();
  const queue = [dfa.start];
  map.set(dfa.start, 0);
  while (queue.length) {
    const s = queue.shift();
    order.push(s);
    for (const a of dfa.alphabet) {
      const t = dfa.trans[s].get(a);
      if (t !== undefined && !map.has(t)) { map.set(t, map.size); queue.push(t); }
    }
  }
  const trans = order.map((old) => {
    const m = new Map();
    for (const a of dfa.alphabet) {
      const t = dfa.trans[old].get(a);
      if (t !== undefined) m.set(a, map.get(t));
    }
    return m;
  });
  const finals = new Set([...dfa.finals].filter((s) => map.has(s)).map((s) => map.get(s)));
  return { alphabet: dfa.alphabet, start: 0, finals, trans };
}

// ---------- Hopcroft-style partition refinement minimization ----------
function minimizeDfa(dfa) {
  const n = dfa.trans.length;
  // reachable states only
  const reach = new Set([dfa.start]);
  const stack = [dfa.start];
  while (stack.length) {
    const s = stack.pop();
    for (const [, t] of dfa.trans[s]) {
      if (!reach.has(t)) { reach.add(t); stack.push(t); }
    }
  }

  let blocks = [];
  const nonFinal = [...reach].filter((s) => !dfa.finals.has(s));
  const final = [...reach].filter((s) => dfa.finals.has(s));
  if (nonFinal.length) blocks.push(nonFinal);
  if (final.length) blocks.push(final);

  const cls = new Array(n).fill(-1);
  const assign = () => blocks.forEach((b, i) => b.forEach((s) => { cls[s] = i; }));
  assign();

  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const b of blocks) {
      const groups = new Map();
      for (const s of b) {
        const sig = dfa.alphabet
          .map((a) => {
            const t = dfa.trans[s].get(a);
            return t === undefined ? -1 : cls[t];
          })
          .join('|');
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(s);
      }
      if (groups.size > 1) changed = true;
      for (const g of groups.values()) next.push(g);
    }
    blocks = next;
    assign();
  }

  const sub = {
    alphabet: dfa.alphabet,
    start: cls[dfa.start],
    finals: new Set([...dfa.finals].filter((s) => reach.has(s)).map((s) => cls[s])),
    trans: blocks.map(() => new Map()),
  };
  blocks.forEach((b, i) => {
    const rep = b[0];
    for (const [a, t] of dfa.trans[rep]) sub.trans[i].set(a, cls[t]);
  });
  return canonicalize(sub);
}

function hasReachableFinal(dfa) {
  return dfa.finals.size > 0; // canonicalized DFA keeps only reachable states
}

// ---------- Compile regex source into a minimized DFA ----------
function compileFlow(src) {
  const ast = parse(src);
  const alphabet = literals(ast).sort();
  if (alphabet.length === 0) {
    throw new FlowError('EMPTY_ALPHABET', 'flow regex mentions no events');
  }
  const dfa = minimizeDfa(nfaToDfa(buildNfa(ast), alphabet));
  if (!hasReachableFinal(dfa)) {
    throw new FlowError('NONTERM_AUTOMATON', 'flow automaton can never accept');
  }
  return { ast, dfa, alphabet };
}

module.exports = { buildNfa, nfaToDfa, minimizeDfa, canonicalize, compileFlow };
