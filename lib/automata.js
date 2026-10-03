'use strict';

const crypto = require('node:crypto');
const { alphabetOf } = require('./regex');

// ---------- NFA ----------

function newNfa() {
  return { nextState: 0, start: 0, accepts: new Set(), trans: new Map() };
}

function addState(nfa) {
  return nfa.nextState++;
}

function addTrans(nfa, from, sym, to) {
  let list = nfa.trans.get(from);
  if (!list) nfa.trans.set(from, (list = []));
  list.push([sym, to]);
}

// Thompson construction; intersection and complement are compiled by
// determinizing their operands (complement requires an explicit alphabet).
function toNFA(ast, alphabet) {
  switch (ast.type) {
    case 'lit': {
      const nfa = newNfa();
      const s = addState(nfa);
      const t = addState(nfa);
      nfa.start = s;
      nfa.accepts.add(t);
      addTrans(nfa, s, ast.ch, t);
      return nfa;
    }
    case 'eps': {
      const nfa = newNfa();
      const s = addState(nfa);
      nfa.start = s;
      nfa.accepts.add(s);
      return nfa;
    }
    case 'empty': {
      const nfa = newNfa();
      nfa.start = addState(nfa);
      return nfa;
    }
    case 'concat': {
      const nfa = newNfa();
      let prevAccepts = null;
      let start = null;
      for (const child of ast.xs) {
        const sub = embed(nfa, toNFA(child, alphabet));
        if (start === null) start = sub.start;
        if (prevAccepts) {
          for (const a of prevAccepts) addTrans(nfa, a, null, sub.start);
        }
        prevAccepts = sub.accepts;
      }
      nfa.start = start === null ? addState(nfa) : start;
      if (prevAccepts === null) nfa.accepts.add(nfa.start);
      else for (const a of prevAccepts) nfa.accepts.add(a);
      return nfa;
    }
    case 'alt': {
      const nfa = newNfa();
      const s = addState(nfa);
      nfa.start = s;
      for (const child of ast.xs) {
        const sub = embed(nfa, toNFA(child, alphabet));
        addTrans(nfa, s, null, sub.start);
        for (const a of sub.accepts) nfa.accepts.add(a);
      }
      return nfa;
    }
    case 'star': {
      const nfa = newNfa();
      const s = addState(nfa);
      const sub = embed(nfa, toNFA(ast.x, alphabet));
      nfa.start = s;
      nfa.accepts.add(s);
      addTrans(nfa, s, null, sub.start);
      for (const a of sub.accepts) addTrans(nfa, a, null, s);
      return nfa;
    }
    case 'inter': {
      const dfas = ast.xs.map((x) => determinize(toNFA(x, alphabet), alphabet));
      const prod = dfas.reduce((acc, d) => productDFA(acc, d, 'inter'));
      return dfaToNfa(prod);
    }
    case 'compl': {
      if (!alphabet) {
        throw new Error('complement requires an explicit alphabet');
      }
      const dfa = completeDFA(determinize(toNFA(ast.x, alphabet), alphabet));
      const accepts = new Set();
      for (const s of dfa.states) {
        if (!dfa.accepts.has(s)) accepts.add(s);
      }
      return dfaToNfa({ ...dfa, accepts });
    }
    default:
      throw new Error(`unknown node type ${ast.type}`);
  }
}

function embed(target, sub) {
  const offset = target.nextState;
  target.nextState += sub.nextState;
  for (const [from, list] of sub.trans) {
    for (const [sym, to] of list) addTrans(target, from + offset, sym, to + offset);
  }
  return {
    start: sub.start + offset,
    accepts: [...sub.accepts].map((s) => s + offset),
  };
}

function dfaToNfa(dfa) {
  const nfa = newNfa();
  nfa.nextState = dfa.states.length === 0 ? 1 : Math.max(...dfa.states) + 1;
  nfa.start = dfa.start;
  nfa.accepts = new Set(dfa.accepts);
  for (const [key, to] of dfa.trans) {
    const sep = key.indexOf(' ');
    const from = Number(key.slice(0, sep));
    const sym = key.slice(sep + 1);
    addTrans(nfa, from, sym, to);
  }
  return nfa;
}

// ---------- DFA ----------

function epsClosure(nfa, states) {
  const seen = new Set(states);
  const stack = [...states];
  while (stack.length > 0) {
    const s = stack.pop();
    for (const [sym, to] of nfa.trans.get(s) || []) {
      if (sym === null && !seen.has(to)) {
        seen.add(to);
        stack.push(to);
      }
    }
  }
  return seen;
}

function nfaSymbols(nfa) {
  const out = new Set();
  for (const list of nfa.trans.values()) {
    for (const [sym] of list) if (sym !== null) out.add(sym);
  }
  return out;
}

function determinize(nfa, alphabet) {
  const symbols = new Set(nfaSymbols(nfa));
  if (alphabet) for (const c of alphabet) symbols.add(c);
  const alpha = [...symbols].sort();

  const startSet = epsClosure(nfa, [nfa.start]);
  const keyOf = (set) => [...set].sort((x, y) => x - y).join(',');
  const ids = new Map([[keyOf(startSet), 0]]);
  const sets = [startSet];
  const trans = new Map();
  const accepts = new Set();
  const queue = [0];

  while (queue.length > 0) {
    const id = queue.shift();
    const set = sets[id];
    if ([...set].some((s) => nfa.accepts.has(s))) accepts.add(id);
    for (const sym of alpha) {
      const targets = new Set();
      for (const s of set) {
        for (const [t, to] of nfa.trans.get(s) || []) {
          if (t === sym) targets.add(to);
        }
      }
      if (targets.size === 0) continue;
      const closed = epsClosure(nfa, targets);
      const k = keyOf(closed);
      let tid = ids.get(k);
      if (tid === undefined) {
        tid = sets.length;
        ids.set(k, tid);
        sets.push(closed);
        queue.push(tid);
      }
      trans.set(`${id} ${sym}`, tid);
    }
  }

  return {
    alphabet: alpha,
    states: sets.map((_, i) => i),
    start: 0,
    accepts,
    trans,
  };
}

function completeDFA(dfa) {
  const trans = new Map(dfa.trans);
  const states = [...dfa.states];
  let sink = null;
  for (const s of states) {
    for (const sym of dfa.alphabet) {
      if (!trans.has(`${s} ${sym}`)) {
        if (sink === null) {
          sink = states.length;
          states.push(sink);
        }
        trans.set(`${s} ${sym}`, sink);
      }
    }
  }
  if (sink !== null) {
    for (const sym of dfa.alphabet) trans.set(`${sink} ${sym}`, sink);
  }
  return { ...dfa, states, trans };
}

function productDFA(d1, d2, op) {
  const alphabet = [...new Set([...d1.alphabet, ...d2.alphabet])].sort();
  const a = completeDFA({ ...d1, alphabet });
  const b = completeDFA({ ...d2, alphabet });
  const getA = (s, c) => a.trans.get(`${s} ${c}`);
  const getB = (s, c) => b.trans.get(`${s} ${c}`);

  const ids = new Map([[`${a.start},${b.start}`, 0]]);
  const pairs = [[a.start, b.start]];
  const trans = new Map();
  const accepts = new Set();
  const queue = [0];

  while (queue.length > 0) {
    const id = queue.shift();
    const [sa, sb] = pairs[id];
    const inA = a.accepts.has(sa);
    const inB = b.accepts.has(sb);
    if ((op === 'inter' && inA && inB) || (op === 'union' && (inA || inB))) {
      accepts.add(id);
    }
    for (const sym of alphabet) {
      const ta = getA(sa, sym);
      const tb = getB(sb, sym);
      const k = `${ta},${tb}`;
      let tid = ids.get(k);
      if (tid === undefined) {
        tid = pairs.length;
        ids.set(k, tid);
        pairs.push([ta, tb]);
        queue.push(tid);
      }
      trans.set(`${id} ${sym}`, tid);
    }
  }

  return {
    alphabet,
    states: pairs.map((_, i) => i),
    start: 0,
    accepts,
    trans,
  };
}

function reachableStates(dfa) {
  const seen = new Set([dfa.start]);
  const stack = [dfa.start];
  while (stack.length > 0) {
    const s = stack.pop();
    for (const sym of dfa.alphabet) {
      const t = dfa.trans.get(`${s} ${sym}`);
      if (t !== undefined && !seen.has(t)) {
        seen.add(t);
        stack.push(t);
      }
    }
  }
  return seen;
}

// Partition-refinement minimization over the reachable, complete DFA.
function minimize(dfa) {
  const complete = completeDFA(dfa);
  const reachable = reachableStates(complete);
  const states = [...reachable].sort((x, y) => x - y);
  const isAccept = (s) => complete.accepts.has(s);
  const next = (s, c) => complete.trans.get(`${s} ${c}`);

  let blocks = [];
  const accBlock = states.filter(isAccept);
  const nonBlock = states.filter((s) => !isAccept(s));
  if (accBlock.length) blocks.push(accBlock);
  if (nonBlock.length) blocks.push(nonBlock);

  let blockOf = new Map();
  const reindex = () => {
    blockOf = new Map();
    blocks.forEach((b, i) => b.forEach((s) => blockOf.set(s, i)));
  };
  reindex();

  for (;;) {
    const sigToBlock = new Map();
    const newBlocks = [];
    for (const block of blocks) {
      for (const s of block) {
        const sig = complete.alphabet.map((c) => blockOf.get(next(s, c))).join(',');
        const key = `${blockOf.get(s)}|${sig}`;
        let nb = sigToBlock.get(key);
        if (!nb) sigToBlock.set(key, (nb = []));
        nb.push(s);
      }
    }
    for (const b of sigToBlock.values()) newBlocks.push(b);
    if (newBlocks.length === blocks.length) break;
    blocks = newBlocks;
    reindex();
  }
  reindex();

  const trans = new Map();
  const accepts = new Set();
  for (const [i, block] of blocks.entries()) {
    const rep = block[0];
    if (isAccept(rep)) accepts.add(i);
    for (const c of complete.alphabet) {
      trans.set(`${i} ${c}`, blockOf.get(next(rep, c)));
    }
  }

  return {
    alphabet: complete.alphabet,
    states: blocks.map((_, i) => i),
    start: blockOf.get(complete.start),
    accepts,
    trans,
  };
}

// BFS shortest accepted string; null when the language is empty.
function shortestWitness(dfa) {
  if (dfa.accepts.has(dfa.start)) return '';
  const seen = new Set([dfa.start]);
  const queue = [[dfa.start, '']];
  while (queue.length > 0) {
    const [s, w] = queue.shift();
    for (const sym of dfa.alphabet) {
      const t = dfa.trans.get(`${s} ${sym}`);
      if (t === undefined || seen.has(t)) continue;
      const w2 = w + sym;
      if (dfa.accepts.has(t)) return w2;
      seen.add(t);
      queue.push([t, w2]);
    }
  }
  return null;
}

// Canonical (BFS-order) relabeling of a minimal DFA, so that equal languages
// over equal alphabets always hash identically.
function canonicalForm(minDfa) {
  const order = [];
  const rename = new Map([[minDfa.start, 0]]);
  const queue = [minDfa.start];
  while (queue.length > 0) {
    const s = queue.shift();
    order.push(s);
    for (const c of minDfa.alphabet) {
      const t = minDfa.trans.get(`${s} ${c}`);
      if (!rename.has(t)) {
        rename.set(t, rename.size);
        queue.push(t);
      }
    }
  }
  const lines = [];
  lines.push(`alpha=${minDfa.alphabet.join(',')}`);
  lines.push(`start=${rename.get(minDfa.start)}`);
  lines.push(`accepts=${[...minDfa.accepts].map((s) => rename.get(s)).sort((x, y) => x - y).join(',')}`);
  for (const s of order) {
    for (const c of minDfa.alphabet) {
      lines.push(`${rename.get(s)} --${c}--> ${rename.get(minDfa.trans.get(`${s} ${c}`))}`);
    }
  }
  return lines.join('\n');
}

function certHash(minDfa) {
  return crypto.createHash('sha256').update(canonicalForm(minDfa)).digest('hex').slice(0, 16);
}

// ---------- projection ----------

// Project an NFA onto a kept-symbol subset: other symbols become epsilon.
function projectNfa(nfa, keep) {
  const out = newNfa();
  out.nextState = nfa.nextState;
  out.start = nfa.start;
  out.accepts = new Set(nfa.accepts);
  for (const [from, list] of nfa.trans) {
    for (const [sym, to] of list) {
      addTrans(out, from, sym === null || keep.has(sym) ? sym : null, to);
    }
  }
  return out;
}

module.exports = {
  toNFA,
  determinize,
  completeDFA,
  productDFA,
  minimize,
  shortestWitness,
  canonicalForm,
  certHash,
  projectNfa,
  nfaSymbols,
};
