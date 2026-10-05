'use strict';

const { createHash } = require('crypto');
const { ALPHABET, ALPHABET_SIZE } = require('./tokens');

// ---------- NFA (Thompson construction) ----------

function buildNFA(ast) {
  const eps = []; // eps[s] -> array of targets
  const sym = []; // sym[s] -> Map(token -> array of targets)
  let count = 0;

  function newState() {
    const id = count++;
    eps[id] = [];
    sym[id] = new Map();
    return id;
  }
  function addEps(from, to) { eps[from].push(to); }
  function addSym(from, token, to) {
    const m = sym[from];
    if (!m.has(token)) m.set(token, []);
    m.get(token).push(to);
  }

  function build(node) {
    // returns {start, accept}
    switch (node.type) {
      case 'empty': {
        const s = newState(), a = newState();
        addEps(s, a);
        return { start: s, accept: a };
      }
      case 'token': {
        const s = newState(), a = newState();
        for (const tok of node.tokens) addSym(s, tok, a);
        return { start: s, accept: a };
      }
      case 'concat': {
        let frag = build(node.parts[0]);
        for (let i = 1; i < node.parts.length; i++) {
          const nextFrag = build(node.parts[i]);
          addEps(frag.accept, nextFrag.start);
          frag = { start: frag.start, accept: nextFrag.accept };
        }
        return frag;
      }
      case 'alt': {
        const s = newState(), a = newState();
        for (const opt of node.options) {
          const f = build(opt);
          addEps(s, f.start);
          addEps(f.accept, a);
        }
        return { start: s, accept: a };
      }
      case 'star': {
        const s = newState(), a = newState();
        const f = build(node.expr);
        addEps(s, f.start);
        addEps(s, a);
        addEps(f.accept, f.start);
        addEps(f.accept, a);
        return { start: s, accept: a };
      }
      case 'plus': {
        const s = newState(), a = newState();
        const f = build(node.expr);
        addEps(s, f.start);
        addEps(f.accept, f.start);
        addEps(f.accept, a);
        return { start: s, accept: a };
      }
      case 'opt': {
        const s = newState(), a = newState();
        const f = build(node.expr);
        addEps(s, f.start);
        addEps(s, a);
        addEps(f.accept, a);
        return { start: s, accept: a };
      }
      default:
        throw new Error(`unresolved AST node: ${node.type}`);
    }
  }

  const frag = build(ast);
  return { count, eps, sym, start: frag.start, accept: frag.accept };
}

function unionNFA(asts) {
  const eps = [], sym = [];
  let count = 0;
  const parts = asts.map((ast) => {
    const nfa = buildNFA(ast);
    const offset = count;
    for (let i = 0; i < nfa.count; i++) {
      eps[offset + i] = nfa.eps[i].map((t) => t + offset);
      const shifted = new Map();
      for (const [tok, targets] of nfa.sym[i]) {
        shifted.set(tok, targets.map((t) => t + offset));
      }
      sym[offset + i] = shifted;
    }
    count += nfa.count;
    return { start: nfa.start + offset, accept: nfa.accept + offset };
  });
  eps[count] = [];
  sym[count] = new Map();
  const start = count++;
  for (const p of parts) eps[start].push(p.start);
  const accept = new Set(parts.map((p) => p.accept));
  return { count, eps, sym, start, acceptSet: accept };
}

// ---------- Determinization ----------

function determinize(nfa) {
  function epsClosure(states) {
    const stack = [...states];
    const seen = new Set(states);
    while (stack.length) {
      const s = stack.pop();
      for (const t of nfa.eps[s]) {
        if (!seen.has(t)) { seen.add(t); stack.push(t); }
      }
    }
    return seen;
  }

  const startSet = epsClosure([nfa.start]);
  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const dfaStates = [];
  const dfaTrans = []; // array of Map(token -> dstate)
  const dfaAccept = new Set();
  const idOf = new Map();

  function intern(set) {
    const key = keyOf(set);
    if (idOf.has(key)) return idOf.get(key);
    const id = dfaStates.length;
    idOf.set(key, id);
    dfaStates.push(set);
    dfaTrans.push(new Map());
    for (const s of set) if (nfa.acceptSet.has(s)) { dfaAccept.add(id); break; }
    return id;
  }

  const startId = intern(startSet);
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    const moves = new Map(); // token -> set of nfa states
    for (const s of dfaStates[id]) {
      for (const [tok, targets] of nfa.sym[s]) {
        if (!moves.has(tok)) moves.set(tok, new Set());
        const dst = moves.get(tok);
        for (const t of targets) dst.add(t);
      }
    }
    for (const [tok, targets] of moves) {
      const closure = epsClosure(targets);
      const tid = intern(closure);
      if (!dfaTrans[id].has(tok)) {
        dfaTrans[id].set(tok, tid);
        if (tid === dfaStates.length - 1 && !queue.includes(tid)) queue.push(tid);
      }
    }
  }
  return { states: dfaStates.length, start: startId, accept: dfaAccept, trans: dfaTrans };
}

// ---------- Complete DFA over the full token alphabet ----------

function toCompleteTable(dfa) {
  const n = dfa.states + 1; // + sink
  const sink = dfa.states;
  const table = [];
  for (let s = 0; s < n; s++) {
    const row = new Int32Array(ALPHABET_SIZE);
    const m = s < dfa.states ? dfa.trans[s] : null;
    for (let i = 0; i < ALPHABET_SIZE; i++) {
      const tok = ALPHABET[i];
      const t = m && m.has(tok) ? m.get(tok) : sink;
      row[i] = t;
    }
    table.push(row);
  }
  return { states: n, start: dfa.start, accept: new Set(dfa.accept), trans: table, sink };
}

// ---------- Minimization (partition refinement) ----------

function minimizeDFA(dfa) {
  const n = dfa.states;
  const accepting = [], rejecting = [];
  for (let s = 0; s < n; s++) (dfa.accept.has(s) ? accepting : rejecting).push(s);
  let blocks = [accepting, rejecting].filter((b) => b.length > 0);
  let blockOf = new Array(n);
  for (let b = 0; b < blocks.length; b++) for (const s of blocks[b]) blockOf[s] = b;

  let changed = true;
  while (changed) {
    changed = false;
    const next = [];
    for (const block of blocks) {
      const groups = new Map();
      for (const s of block) {
        const row = dfa.trans[s];
        const sig = new Array(ALPHABET_SIZE);
        for (let i = 0; i < ALPHABET_SIZE; i++) sig[i] = blockOf[row[i]];
        const key = sig.join(',');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      for (const g of groups.values()) next.push(g);
      if (groups.size > 1) changed = true;
    }
    blocks = next;
    for (let b = 0; b < blocks.length; b++) for (const s of blocks[b]) blockOf[s] = b;
  }

  const k = blocks.length;
  const trans = [];
  const accept = new Set();
  for (let b = 0; b < k; b++) {
    const rep = blocks[b][0];
    const row = new Int32Array(ALPHABET_SIZE);
    for (let i = 0; i < ALPHABET_SIZE; i++) row[i] = blockOf[dfa.trans[rep][i]];
    trans.push(row);
    if (dfa.accept.has(rep)) accept.add(b);
  }
  return { states: k, start: blockOf[dfa.start], accept, trans };
}

// ---------- Canonical form + certificate ----------

function canonicalForm(dfa) {
  const idOf = new Map([[dfa.start, 0]]);
  const order = [dfa.start];
  const queue = [dfa.start];
  while (queue.length) {
    const s = queue.shift();
    for (let i = 0; i < ALPHABET_SIZE; i++) {
      const t = dfa.trans[s][i];
      if (!idOf.has(t)) {
        idOf.set(t, idOf.size);
        order.push(t);
        queue.push(t);
      }
    }
  }
  const trans = [];
  for (const s of order) {
    for (let i = 0; i < ALPHABET_SIZE; i++) {
      trans.push([idOf.get(s), i, idOf.get(dfa.trans[s][i])]);
    }
  }
  const accept = order.filter((s) => dfa.accept.has(s)).map((s) => idOf.get(s));
  return { states: idOf.size, start: 0, accept, trans };
}

function certificate(dfa) {
  const canon = canonicalForm(dfa);
  const hash = createHash('sha256').update(JSON.stringify(canon)).digest('hex');
  return { states: canon.states, hash, canon };
}

function compileAsts(asts) {
  const nfa = unionNFA(asts);
  const dfa = determinize(nfa);
  const complete = toCompleteTable(dfa);
  return minimizeDFA(complete);
}

// ---------- Equivalence + witness ----------

function findWitness(dfaA, dfaB) {
  // BFS over the product DFA; tokens explored in alphabet (lexicographic) order,
  // so the first divergence found is shortest, then lexicographically smallest.
  const startKey = `${dfaA.start}|${dfaB.start}`;
  const visited = new Set([startKey]);
  const queue = [{ a: dfaA.start, b: dfaB.start, path: [] }];
  while (queue.length) {
    const { a, b, path } = queue.shift();
    const accA = dfaA.accept.has(a);
    const accB = dfaB.accept.has(b);
    if (accA !== accB) return path;
    for (let i = 0; i < ALPHABET_SIZE; i++) {
      const na = dfaA.trans[a][i];
      const nb = dfaB.trans[b][i];
      const key = `${na}|${nb}`;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ a: na, b: nb, path: [...path, ALPHABET[i]] });
      }
    }
  }
  return null;
}

function checkEquivalence(astsA, astsB) {
  const minA = compileAsts(astsA);
  const minB = compileAsts(astsB);
  const certA = certificate(minA);
  const certB = certificate(minB);
  const equiv = certA.hash === certB.hash;
  const witness = equiv ? null : findWitness(minA, minB);
  return { equiv, certA: { states: certA.states, hash: certA.hash }, certB: { states: certB.states, hash: certB.hash }, witness };
}

module.exports = {
  buildNFA,
  unionNFA,
  determinize,
  toCompleteTable,
  minimizeDFA,
  canonicalForm,
  certificate,
  compileAsts,
  findWitness,
  checkEquivalence,
};
