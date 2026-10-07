'use strict';

const crypto = require('crypto');
const { ALPHABET } = require('./tokenize');

const NUM_SYMBOLS = ALPHABET.length;

// ---------- NFA (Thompson construction) ----------
// nfa = { trans: Array<Array<{symbols: number[]|null, to: number}>>, start, accept }

function buildNFA(ast) {
  const trans = [];
  const addState = () => {
    trans.push([]);
    return trans.length - 1;
  };
  const eps = (from, to) => trans[from].push({ symbols: null, to });

  function build(node) {
    switch (node.type) {
      case 'eps': {
        const s = addState();
        const e = addState();
        eps(s, e);
        return { start: s, end: e };
      }
      case 'token': {
        const s = addState();
        const e = addState();
        trans[s].push({ symbols: node.symbols, to: e });
        return { start: s, end: e };
      }
      case 'concat': {
        let cur = null;
        for (const part of node.parts) {
          const frag = build(part);
          if (cur) eps(cur.end, frag.start);
          else cur = frag;
          if (cur !== frag) cur = { start: cur.start, end: frag.end };
        }
        return cur;
      }
      case 'alt': {
        const s = addState();
        const e = addState();
        for (const opt of node.options) {
          const frag = build(opt);
          eps(s, frag.start);
          eps(frag.end, e);
        }
        return { start: s, end: e };
      }
      case 'star': {
        const s = addState();
        const e = addState();
        const frag = build(node.expr);
        eps(s, frag.start);
        eps(s, e);
        eps(frag.end, frag.start);
        eps(frag.end, e);
        return { start: s, end: e };
      }
      case 'plus': {
        const s = addState();
        const e = addState();
        const frag = build(node.expr);
        eps(s, frag.start);
        eps(frag.end, frag.start);
        eps(frag.end, e);
        return { start: s, end: e };
      }
      case 'opt': {
        const s = addState();
        const e = addState();
        const frag = build(node.expr);
        eps(s, frag.start);
        eps(s, e);
        eps(frag.end, e);
        return { start: s, end: e };
      }
      default:
        throw new Error(`unknown AST node ${node.type}`);
    }
  }

  const { start, end } = build(ast);
  return { trans, start, accept: end };
}

// ---------- Determinization (subset construction) ----------
// dfa = { start, trans: Array<Map<number, number>>, accept: Set<number> }

function determinize(nfa) {
  const closure = (set) => {
    const stack = [...set];
    const out = new Set(set);
    while (stack.length) {
      const s = stack.pop();
      for (const t of nfa.trans[s]) {
        if (t.symbols === null && !out.has(t.to)) {
          out.add(t.to);
          stack.push(t.to);
        }
      }
    }
    return out;
  };

  const keyOf = (set) => [...set].sort((x, y) => x - y).join(',');
  const startSet = closure([nfa.start]);
  const states = [startSet];
  const ids = new Map([[keyOf(startSet), 0]]);
  const trans = [];
  const accept = new Set();
  const queue = [0];

  while (queue.length) {
    const id = queue.shift();
    const set = states[id];
    if (set.has(nfa.accept)) accept.add(id);
    const bySym = new Map(); // sym -> Set of nfa targets
    for (const s of set) {
      for (const t of nfa.trans[s]) {
        if (t.symbols === null) continue;
        for (const sym of t.symbols) {
          let tgt = bySym.get(sym);
          if (!tgt) bySym.set(sym, (tgt = new Set()));
          tgt.add(t.to);
        }
      }
    }
    const row = new Map();
    for (const [sym, targets] of bySym) {
      const cl = closure(targets);
      const k = keyOf(cl);
      let tid = ids.get(k);
      if (tid === undefined) {
        tid = states.length;
        ids.set(k, tid);
        states.push(cl);
        queue.push(tid);
      }
      row.set(sym, tid);
    }
    trans[id] = row;
  }
  return { start: 0, trans, accept };
}

// ---------- Completion (add explicit dead state) ----------
// Returns { n, start, dead, table: Array<Int32Array>, accept: boolean[] }

function complete(dfa) {
  const n0 = dfa.trans.length;
  const needsDead = dfa.trans.some((row) => row.size < NUM_SYMBOLS) || n0 === 0;
  const n = needsDead ? n0 + 1 : n0;
  const dead = needsDead ? n0 : -1;
  const table = new Array(n);
  for (let s = 0; s < n0; s++) {
    const row = new Int32Array(NUM_SYMBOLS);
    for (let sym = 0; sym < NUM_SYMBOLS; sym++) {
      const t = dfa.trans[s].get(sym);
      row[sym] = t === undefined ? dead : t;
    }
    table[s] = row;
  }
  if (needsDead) table[dead] = new Int32Array(NUM_SYMBOLS).fill(dead);
  const accept = new Array(n).fill(false);
  for (const s of dfa.accept) accept[s] = true;
  return { n, start: dfa.start, dead, table, accept };
}

// ---------- Minimization (partition refinement on complete DFA) ----------

function minimize(cd) {
  const { n, table, accept } = cd;
  let blockOf = new Array(n);
  let blocks = [];
  {
    const acc = [];
    const non = [];
    for (let s = 0; s < n; s++) (accept[s] ? acc : non).push(s);
    if (non.length) blocks.push(non);
    if (acc.length) blocks.push(acc);
    blocks.forEach((b, i) => b.forEach((s) => (blockOf[s] = i)));
  }

  let changed = true;
  while (changed) {
    changed = false;
    const sigMap = new Map();
    const newBlockOf = new Array(n);
    const newBlocks = [];
    for (const block of blocks) {
      const groups = new Map();
      for (const s of block) {
        let sig = '';
        for (let sym = 0; sym < NUM_SYMBOLS; sym++) sig += blockOf[table[s][sym]] + '.';
        let g = groups.get(sig);
        if (!g) groups.set(sig, (g = []));
        g.push(s);
      }
      for (const g of groups.values()) {
        const id = newBlocks.length;
        for (const s of g) newBlockOf[s] = id;
        newBlocks.push(g);
      }
    }
    if (newBlocks.length !== blocks.length) changed = true;
    blocks = newBlocks;
    blockOf = newBlockOf;
  }

  // Rebuild minimized complete DFA.
  const m = blocks.length;
  const table2 = new Array(m);
  const accept2 = new Array(m).fill(false);
  for (let i = 0; i < m; i++) {
    const rep = blocks[i][0];
    const row = new Int32Array(NUM_SYMBOLS);
    for (let sym = 0; sym < NUM_SYMBOLS; sym++) row[sym] = blockOf[table[rep][sym]];
    table2[i] = row;
    accept2[i] = accept[rep];
  }
  return { n: m, start: blockOf[cd.start], table: table2, accept: accept2 };
}

// ---------- Canonical numbering (BFS from start, symbols in lex order) ----------

function canonicalize(md) {
  const order = new Array(md.n).fill(-1);
  order[md.start] = 0;
  const queue = [md.start];
  let next = 1;
  while (queue.length) {
    const s = queue.shift();
    for (let sym = 0; sym < NUM_SYMBOLS; sym++) {
      const t = md.table[s][sym];
      if (order[t] === -1) {
        order[t] = next++;
        queue.push(t);
      }
    }
  }
  const table = new Array(md.n);
  const accept = new Array(md.n).fill(false);
  for (let s = 0; s < md.n; s++) {
    const ns = order[s];
    const row = new Int32Array(NUM_SYMBOLS);
    for (let sym = 0; sym < NUM_SYMBOLS; sym++) row[sym] = order[md.table[s][sym]];
    table[ns] = row;
    accept[ns] = md.accept[s];
  }
  return { n: md.n, start: 0, table, accept };
}

// ---------- Certificate: state count + transition hash ----------

function certificate(cd) {
  const lines = [`states=${cd.n}`, `start=${cd.start}`];
  lines.push(`accept=${cd.accept.map((a, i) => (a ? i : -1)).filter((i) => i >= 0).join(',')}`);
  for (let s = 0; s < cd.n; s++) {
    for (let sym = 0; sym < NUM_SYMBOLS; sym++) {
      lines.push(`t ${s} ${ALPHABET[sym]} ${cd.table[s][sym]}`);
    }
  }
  const hash = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
  return { states: cd.n, hash };
}

// ---------- Full pipeline: AST -> canonical minimal complete DFA ----------

function compileAst(ast) {
  const nfa = buildNFA(ast);
  const dfa = determinize(nfa);
  return canonicalize(minimize(complete(dfa)));
}

// Wrap a rule AST with .* prefix so "hit" = some substring ending here matches.
function hitAst(ast) {
  const anyToken = {
    type: 'token',
    symbols: Array.from({ length: NUM_SYMBOLS }, (_, i) => i),
  };
  return {
    type: 'concat',
    parts: [{ type: 'star', expr: anyToken }, ast],
  };
}

// Run a complete DFA over token indices; returns accept flags per position.
function runDfa(cd, tokenIndices) {
  const out = new Array(tokenIndices.length);
  let s = cd.start;
  for (let i = 0; i < tokenIndices.length; i++) {
    s = cd.table[s][tokenIndices[i]];
    out[i] = cd.accept[s];
  }
  return out;
}

module.exports = {
  NUM_SYMBOLS,
  buildNFA,
  determinize,
  complete,
  minimize,
  canonicalize,
  certificate,
  compileAst,
  hitAst,
  runDfa,
};
