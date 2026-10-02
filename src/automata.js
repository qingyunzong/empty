'use strict';

// NFA:  { size, start, accepts:Set<number>, trans:Array<Array<{sym,to}>> }
//        sym === null means epsilon.
// DFA:  { size, start, accepts:Set<number>, trans:Array<Map<string,number>> }
//        DFAs returned by minimize() are complete and canonically ordered
//        (states numbered in BFS order from the start, symbols sorted), so
//        equivalent automata have identical structure and identical hashes.

function nfaFromAst(ast, alphabet) {
  const trans = [];
  const newState = () => {
    trans.push([]);
    return trans.length - 1;
  };
  const edge = (from, to, sym) => trans[from].push({ sym, to });

  function rec(node) {
    switch (node.type) {
      case 'eps': {
        const s = newState();
        const a = newState();
        edge(s, a, null);
        return { s, a };
      }
      case 'lit': {
        const s = newState();
        const a = newState();
        edge(s, a, node.ch);
        return { s, a };
      }
      case 'any': {
        const s = newState();
        const a = newState();
        for (const c of alphabet) edge(s, a, c);
        return { s, a };
      }
      case 'class': {
        const s = newState();
        const a = newState();
        const syms = node.negate
          ? alphabet.filter((c) => !node.chars.includes(c))
          : node.chars;
        for (const c of syms) edge(s, a, c);
        return { s, a };
      }
      case 'concat': {
        let cur = null;
        for (const part of node.parts) {
          const f = rec(part);
          if (cur === null) {
            cur = f;
          } else {
            edge(cur.a, f.s, null);
            cur = { s: cur.s, a: f.a };
          }
        }
        return cur;
      }
      case 'alt': {
        const s = newState();
        const a = newState();
        for (const opt of node.options) {
          const f = rec(opt);
          edge(s, f.s, null);
          edge(f.a, a, null);
        }
        return { s, a };
      }
      case 'star': {
        const s = newState();
        const a = newState();
        const f = rec(node.expr);
        edge(s, a, null);
        edge(s, f.s, null);
        edge(f.a, f.s, null);
        edge(f.a, a, null);
        return { s, a };
      }
      case 'plus': {
        const s = newState();
        const a = newState();
        const f = rec(node.expr);
        edge(s, f.s, null);
        edge(f.a, f.s, null);
        edge(f.a, a, null);
        return { s, a };
      }
      case 'opt': {
        const s = newState();
        const a = newState();
        const f = rec(node.expr);
        edge(s, a, null);
        edge(s, f.s, null);
        edge(f.a, a, null);
        return { s, a };
      }
      default:
        throw new Error(`unknown AST node type: ${node.type}`);
    }
  }

  const { s, a } = rec(ast);
  return { size: trans.length, start: s, accepts: new Set([a]), trans };
}

// NFA for the union of the *occurrence* languages of the given ASTs:
// a string is accepted iff some rule's pattern occurs as a substring.
function occurrenceNfa(asts, alphabet) {
  const trans = [];
  const newState = () => {
    trans.push([]);
    return trans.length - 1;
  };
  const start = newState();
  for (const c of alphabet) trans[start].push({ sym: c, to: start });
  const accepts = new Set();
  for (const ast of asts) {
    const inner = nfaFromAst(ast, alphabet);
    const off = trans.length;
    for (const t of inner.trans) {
      trans.push(t.map((e) => ({ sym: e.sym, to: e.to + off })));
    }
    trans[start].push({ sym: null, to: inner.start + off });
    for (const a of inner.accepts) {
      accepts.add(a + off);
      for (const c of alphabet) trans[a + off].push({ sym: c, to: a + off });
    }
  }
  return { size: trans.length, start, accepts, trans };
}

function epsClosure(nfa, states) {
  const seen = new Set(states);
  const stack = [...states];
  while (stack.length) {
    const s = stack.pop();
    for (const e of nfa.trans[s]) {
      if (e.sym === null && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

function determinize(nfa, alphabet) {
  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const startSet = epsClosure(nfa, [nfa.start]);
  const ids = new Map([[keyOf(startSet), 0]]);
  const sets = [startSet];
  const trans = [new Map()];
  const accepts = new Set();
  const isAccepting = (set) => {
    for (const s of set) if (nfa.accepts.has(s)) return true;
    return false;
  };
  if (isAccepting(startSet)) accepts.add(0);
  let i = 0;
  while (i < sets.length) {
    const cur = sets[i];
    for (const c of alphabet) {
      const next = new Set();
      for (const s of cur) {
        for (const e of nfa.trans[s]) {
          if (e.sym === c) next.add(e.to);
        }
      }
      if (next.size === 0) continue;
      const cl = epsClosure(nfa, next);
      const k = keyOf(cl);
      if (!ids.has(k)) {
        ids.set(k, sets.length);
        sets.push(cl);
        trans.push(new Map());
        if (isAccepting(cl)) accepts.add(ids.get(k));
      }
      trans[i].set(c, ids.get(k));
    }
    i++;
  }
  return { size: sets.length, start: 0, accepts, trans };
}

// Completes the DFA with a sink, refines partitions to the Myhill-Nerode
// quotient, then renumbers states canonically (BFS from start over the
// sorted alphabet). Deterministic: same language + same alphabet => same DFA.
function minimize(dfa, alphabet) {
  const trans = dfa.trans.map((m) => new Map(m));
  const accepts = new Set(dfa.accepts);
  let size = dfa.size;
  let sink = -1;
  for (let s = 0; s < size; s++) {
    for (const c of alphabet) {
      if (!trans[s].has(c)) {
        if (sink < 0) {
          sink = size++;
          trans.push(new Map());
        }
        trans[s].set(c, sink);
      }
    }
  }

  let blockOf = new Array(size);
  let numBlocks = 0;
  for (let s = 0; s < size; s++) {
    blockOf[s] = accepts.has(s) ? 0 : 1;
  }
  numBlocks = 2;
  for (;;) {
    const sigMap = new Map();
    const next = new Array(size);
    let nextCount = 0;
    for (let s = 0; s < size; s++) {
      let sig = String(blockOf[s]);
      for (const c of alphabet) sig += ',' + blockOf[trans[s].get(c)];
      let id = sigMap.get(sig);
      if (id === undefined) {
        id = nextCount++;
        sigMap.set(sig, id);
      }
      next[s] = id;
    }
    if (nextCount === numBlocks) break;
    blockOf = next;
    numBlocks = nextCount;
  }

  // Quotient transitions (representative = first state of each block).
  const repOf = new Array(numBlocks).fill(-1);
  for (let s = 0; s < size; s++) {
    if (repOf[blockOf[s]] === -1) repOf[blockOf[s]] = s;
  }
  const qAccepts = new Set();
  const qTrans = new Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    const rep = repOf[b];
    if (accepts.has(rep)) qAccepts.add(b);
    const m = new Map();
    for (const c of alphabet) m.set(c, blockOf[trans[rep].get(c)]);
    qTrans[b] = m;
  }
  const qStart = blockOf[dfa.start];

  // Canonical renumbering: BFS from start over sorted symbols.
  const sortedAlpha = [...alphabet].sort();
  const idOf = new Map([[qStart, 0]]);
  const order = [qStart];
  for (let head = 0; head < order.length; head++) {
    const b = order[head];
    for (const c of sortedAlpha) {
      const t = qTrans[b].get(c);
      if (!idOf.has(t)) {
        idOf.set(t, order.length);
        order.push(t);
      }
    }
  }
  const cTrans = order.map((b) => {
    const m = new Map();
    for (const c of sortedAlpha) m.set(c, idOf.get(qTrans[b].get(c)));
    return m;
  });
  const cAccepts = new Set();
  order.forEach((b, idx) => {
    if (qAccepts.has(b)) cAccepts.add(idx);
  });
  return { size: order.length, start: 0, accepts: cAccepts, trans: cTrans };
}

function compileUnion(asts, alphabet) {
  const alpha = [...alphabet].sort();
  return minimize(determinize(occurrenceNfa(asts, alpha), alpha), alpha);
}

function compileMatch(ast, alphabet) {
  const alpha = [...alphabet].sort();
  return minimize(determinize(nfaFromAst(ast, alpha), alpha), alpha);
}

// Stable textual form of a canonical DFA; used for snapshot hashing.
function canonicalString(dfa, alphabet) {
  const alpha = [...alphabet].sort();
  const parts = [];
  parts.push('alpha=' + JSON.stringify(alpha));
  parts.push('n=' + dfa.size);
  const acc = [];
  for (let s = 0; s < dfa.size; s++) acc.push(dfa.accepts.has(s) ? '1' : '0');
  parts.push('acc=' + acc.join(''));
  for (let s = 0; s < dfa.size; s++) {
    parts.push(alpha.map((c) => dfa.trans[s].get(c)).join(','));
  }
  return parts.join(';');
}

// Scans `str`; returns true iff the DFA accepts at any point (the DFA is
// expected to model an occurrence language). Symbols outside the DFA
// alphabet reset the scan, since no match window can contain them.
function scanAccepts(dfa, str) {
  let s = dfa.start;
  if (dfa.accepts.has(s)) return true;
  for (const ch of str) {
    const t = dfa.trans[s].get(ch);
    s = t === undefined ? dfa.start : t;
    if (dfa.accepts.has(s)) return true;
  }
  return false;
}

// Runs a full-match DFA over the whole string.
function fullMatchDfa(dfa, str) {
  let s = dfa.start;
  for (const ch of str) {
    const t = dfa.trans[s].get(ch);
    if (t === undefined) return false;
    s = t;
  }
  return dfa.accepts.has(s);
}

// Shortest string over `alphabet` accepted by exactly one of the two DFAs
// (both complete, same alphabet), or null if they are equivalent.
function distinguishingWitness(dfaA, dfaB, alphabet) {
  const alpha = [...alphabet].sort();
  const differs = (a, b) => dfaA.accepts.has(a) !== dfaB.accepts.has(b);
  if (differs(dfaA.start, dfaB.start)) return '';
  const visited = new Set([dfaA.start + ',' + dfaB.start]);
  let frontier = [{ a: dfaA.start, b: dfaB.start, str: '' }];
  while (frontier.length) {
    const next = [];
    for (const { a, b, str } of frontier) {
      for (const c of alpha) {
        const ta = dfaA.trans[a].get(c);
        const tb = dfaB.trans[b].get(c);
        const s2 = str + c;
        if (differs(ta, tb)) return s2;
        const k = ta + ',' + tb;
        if (!visited.has(k)) {
          visited.add(k);
          next.push({ a: ta, b: tb, str: s2 });
        }
      }
    }
    frontier = next;
  }
  return null;
}

module.exports = {
  nfaFromAst,
  occurrenceNfa,
  determinize,
  minimize,
  compileUnion,
  compileMatch,
  canonicalString,
  scanAccepts,
  fullMatchDfa,
  distinguishingWitness,
};
