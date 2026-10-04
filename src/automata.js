'use strict';

// Regex AST -> NFA (Thompson) -> DFA (subset construction over an atomic
// partition of the code-point space) -> minimal DFA (partition refinement).
// The minimization emits a certificate that verifyMinimization() can check
// independently: a stable partition plus a distinguishing string for every
// pair of blocks (which together prove minimality).

const { parse, MAX_CP } = require('./regex');

// ---------- NFA ----------

function nfaFromAsts(asts) {
  const states = [];
  const addState = () => {
    states.push({ eps: [], trans: [] });
    return states.length - 1;
  };
  const start = addState();
  const accept = addState();

  function build(node, from, to) {
    switch (node.type) {
      case 'eps':
        states[from].eps.push(to);
        break;
      case 'class':
        states[from].trans.push({ ranges: node.ranges, to });
        break;
      case 'concat': {
        let cur = from;
        for (let i = 0; i < node.parts.length; i++) {
          const nxt = i === node.parts.length - 1 ? to : addState();
          build(node.parts[i], cur, nxt);
          cur = nxt;
        }
        break;
      }
      case 'union': {
        for (const opt of node.options) {
          const s = addState();
          const t = addState();
          states[from].eps.push(s);
          states[t].eps.push(to);
          build(opt, s, t);
        }
        break;
      }
      case 'star': {
        const s = addState();
        const t = addState();
        states[from].eps.push(s);
        states[from].eps.push(to);
        states[t].eps.push(s);
        states[t].eps.push(to);
        build(node.node, s, t);
        break;
      }
      case 'maybe': {
        states[from].eps.push(to);
        build(node.node, from, to);
        break;
      }
      default:
        throw new Error(`unknown AST node type: ${node.type}`);
    }
  }

  for (const ast of asts) build(ast, start, accept);
  return { states, start, accept };
}

// ---------- alphabet partition ----------

// Splits [0, MAX_CP] into atomic intervals so that every NFA transition
// range is a union of whole atoms.
function computeAlphabet(nfas) {
  const bounds = new Set([0, MAX_CP + 1]);
  for (const nfa of nfas) {
    for (const st of nfa.states) {
      for (const t of st.trans) {
        for (const [lo, hi] of t.ranges) {
          bounds.add(lo);
          bounds.add(hi + 1);
        }
      }
    }
  }
  const sorted = [...bounds].sort((a, b) => a - b);
  const atoms = [];
  for (let i = 0; i + 1 < sorted.length; i++) atoms.push([sorted[i], sorted[i + 1] - 1]);
  return atoms;
}

function atomIndex(atoms, cp) {
  let lo = 0;
  let hi = atoms.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (atoms[mid][0] <= cp) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function transitionAtoms(ranges, atoms) {
  const out = [];
  for (const [lo, hi] of ranges) {
    let i = atomIndex(atoms, lo);
    while (i < atoms.length && atoms[i][0] <= hi) {
      out.push(i);
      i++;
    }
  }
  return out;
}

// ---------- DFA (subset construction) ----------

function nfaToDfa(nfa, atoms) {
  const atomCount = atoms.length;
  const perState = nfa.states.map((st) => {
    const m = new Map();
    for (const t of st.trans) {
      for (const a of transitionAtoms(t.ranges, atoms)) {
        let arr = m.get(a);
        if (!arr) m.set(a, (arr = []));
        arr.push(t.to);
      }
    }
    return m;
  });

  function closure(set) {
    const out = new Set(set);
    const stack = [...set];
    while (stack.length) {
      const s = stack.pop();
      for (const t of nfa.states[s].eps) {
        if (!out.has(t)) {
          out.add(t);
          stack.push(t);
        }
      }
    }
    return out;
  }

  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const dfa = { states: [], initial: 0 };
  const ids = new Map();
  const queue = [];

  function add(set) {
    const k = keyOf(set);
    if (ids.has(k)) return ids.get(k);
    const id = dfa.states.length;
    ids.set(k, id);
    dfa.states.push({ accept: set.has(nfa.accept), trans: new Int32Array(atomCount).fill(-1), set });
    queue.push(id);
    return id;
  }

  add(closure(new Set([nfa.start])));
  for (let qi = 0; qi < queue.length; qi++) {
    const st = dfa.states[queue[qi]];
    const acc = new Map();
    for (const s of st.set) {
      for (const [a, targets] of perState[s]) {
        let set = acc.get(a);
        if (!set) acc.set(a, (set = new Set()));
        for (const t of targets) set.add(t);
      }
    }
    for (const [a, raw] of acc) st.trans[a] = add(closure(raw));
  }
  return dfa;
}

function dfaMatch(dfa, atoms, str) {
  let s = dfa.initial;
  for (const ch of str) {
    const a = atomIndex(atoms, ch.codePointAt(0));
    s = dfa.states[s].trans[a];
    if (s === -1) return false;
  }
  return dfa.states[s].accept;
}

function compileAst(ast) {
  const nfa = nfaFromAsts([ast]);
  const atoms = computeAlphabet([nfa]);
  const dfa = nfaToDfa(nfa, atoms);
  return { dfa, atoms, match: (s) => dfaMatch(dfa, atoms, s) };
}

// ---------- minimization ----------

// Materializes the implicit dead state so the transition function is total.
function completeDfa(dfa, atomCount) {
  const n0 = dfa.states.length;
  let needDead = false;
  for (const s of dfa.states) {
    for (const t of s.trans) {
      if (t === -1) {
        needDead = true;
        break;
      }
    }
    if (needDead) break;
  }
  const N = needDead ? n0 + 1 : n0;
  const accept = new Array(N).fill(false);
  const trans = new Array(N);
  for (let i = 0; i < n0; i++) {
    accept[i] = dfa.states[i].accept;
    trans[i] = new Array(atomCount);
    for (let a = 0; a < atomCount; a++) {
      const t = dfa.states[i].trans[a];
      trans[i][a] = t === -1 ? n0 : t;
    }
  }
  if (needDead) trans[n0] = new Array(atomCount).fill(n0);
  return { accept, trans, initial: 0, states: N };
}

// BFS on the product automaton for a string accepted from s1 but not s2
// (or vice versa). Atoms are visited in increasing code-point order, so the
// result is the shortest, then numerically smallest distinguishing string.
function distinguish(accept, trans, atoms, s1, s2) {
  const seen = new Set([s1 + ',' + s2]);
  const queue = [{ a: s1, b: s2, str: '' }];
  for (let i = 0; i < queue.length; i++) {
    const { a, b, str } = queue[i];
    if (accept[a] !== accept[b]) return str;
    for (let x = 0; x < atoms.length; x++) {
      const na = trans[a][x];
      const nb = trans[b][x];
      const k = na + ',' + nb;
      if (!seen.has(k)) {
        seen.add(k);
        queue.push({ a: na, b: nb, str: str + String.fromCodePoint(atoms[x][0]) });
      }
    }
  }
  return null;
}

function minimizeDfa(dfa, atoms) {
  const complete = completeDfa(dfa, atoms.length);
  const { accept, trans } = complete;
  const N = accept.length;

  let blockOf = accept.map((a) => (a ? 1 : 0));
  let blockCount = Math.max(...blockOf) + 1;
  for (;;) {
    const sigMap = new Map();
    const next = new Array(N);
    let count = 0;
    for (let s = 0; s < N; s++) {
      let sig = accept[s] ? '1' : '0';
      for (const t of trans[s]) sig += ',' + blockOf[t];
      let b = sigMap.get(sig);
      if (b === undefined) {
        b = count;
        sigMap.set(sig, count);
        count++;
      }
      next[s] = b;
    }
    if (count === blockCount) {
      blockOf = next;
      break;
    }
    blockOf = next;
    blockCount = count;
  }

  const blocks = Array.from({ length: blockCount }, () => []);
  for (let s = 0; s < N; s++) blocks[blockOf[s]].push(s);
  const transitions = blocks.map((blk) => trans[blk[0]].map((t) => blockOf[t]));
  const accepting = [];
  blocks.forEach((blk, i) => {
    if (accept[blk[0]]) accepting.push(i);
  });
  const distinguishing = [];
  for (let i = 0; i < blockCount; i++) {
    for (let j = i + 1; j < blockCount; j++) {
      distinguishing.push({
        a: i,
        b: j,
        witness: distinguish(accept, trans, atoms, blocks[i][0], blocks[j][0]),
      });
    }
  }

  const certificate = {
    states: N,
    initial: blockOf[complete.initial],
    alphabet: atoms,
    blocks,
    transitions,
    accepting,
    distinguishing,
  };
  return { complete, blocks, blockOf, certificate };
}

// Independently verifies that `cert` proves `complete` is minimized:
//  1. blocks form an exact partition of the states;
//  2. every block is consistent (same acceptance, same target blocks);
//  3. cert.transitions matches the recomputed quotient transitions;
//  4. for every pair of blocks a distinguishing string is provided and
//     really separates their representatives.
// (2) shows the partition is a congruence; (4) shows no two blocks are
// equivalent, so the partition is exactly the Myhill-Nerode partition.
function verifyMinimization(complete, cert) {
  const fail = (reason) => ({ ok: false, reason });
  const N = complete.accept.length;
  const A = complete.trans[0].length;
  if (!cert || typeof cert !== 'object') return fail('certificate missing');
  if (cert.states !== N) return fail('state count mismatch');
  if (!Array.isArray(cert.alphabet) || cert.alphabet.length !== A) return fail('alphabet mismatch');
  if (!Array.isArray(cert.blocks) || cert.blocks.length === 0) return fail('no blocks');

  const blockOf = new Array(N).fill(-1);
  let seen = 0;
  for (let i = 0; i < cert.blocks.length; i++) {
    if (!Array.isArray(cert.blocks[i]) || cert.blocks[i].length === 0) return fail('empty block');
    for (const s of cert.blocks[i]) {
      if (!Number.isInteger(s) || s < 0 || s >= N) return fail('state out of range');
      if (blockOf[s] !== -1) return fail('state appears in two blocks');
      blockOf[s] = i;
      seen++;
    }
  }
  if (seen !== N) return fail('blocks do not cover all states');
  if (cert.initial !== blockOf[complete.initial]) return fail('initial block mismatch');

  const K = cert.blocks.length;
  if (!Array.isArray(cert.transitions) || cert.transitions.length !== K) {
    return fail('transition table size mismatch');
  }
  for (let i = 0; i < K; i++) {
    const blk = cert.blocks[i];
    const rep = blk[0];
    const row = cert.transitions[i];
    if (!Array.isArray(row) || row.length !== A) return fail('bad transition row');
    for (let a = 0; a < A; a++) {
      if (row[a] !== blockOf[complete.trans[rep][a]]) return fail('transition mismatch');
    }
    for (const s of blk) {
      if (complete.accept[s] !== complete.accept[rep]) return fail('mixed acceptance in block');
      for (let a = 0; a < A; a++) {
        if (blockOf[complete.trans[s][a]] !== blockOf[complete.trans[rep][a]]) {
          return fail('unstable block');
        }
      }
    }
  }

  const expectedAccepting = [];
  for (let i = 0; i < K; i++) if (complete.accept[cert.blocks[i][0]]) expectedAccepting.push(i);
  if (JSON.stringify(expectedAccepting) !== JSON.stringify(cert.accepting)) {
    return fail('accepting blocks mismatch');
  }

  if (!Array.isArray(cert.distinguishing)) return fail('distinguishing list missing');
  const wantPairs = (K * (K - 1)) / 2;
  if (cert.distinguishing.length !== wantPairs) return fail('missing distinguishing witnesses');
  const pairSeen = new Set();
  for (const entry of cert.distinguishing) {
    const { a, b, witness } = entry;
    if (!(a < b) || b >= K || pairSeen.has(a + ',' + b)) return fail('bad distinguishing pair');
    pairSeen.add(a + ',' + b);
    if (typeof witness !== 'string') return fail('witness is not a string');
    let sa = cert.blocks[a][0];
    let sb = cert.blocks[b][0];
    for (const ch of witness) {
      const x = atomIndex(cert.alphabet, ch.codePointAt(0));
      sa = complete.trans[sa][x];
      sb = complete.trans[sb][x];
    }
    if (complete.accept[sa] === complete.accept[sb]) {
      return fail('witness does not distinguish blocks');
    }
  }
  return { ok: true };
}

// ---------- equivalence with minimal witness ----------

// BFS on the product of two DFAs (dead = -1). Atoms are ordered by their
// smallest code point, so the first divergence found is the shortest and,
// among those, the numerically smallest witness string.
function findWitness(dfaA, dfaB, atoms) {
  const width = dfaB.states.length + 1;
  const key = (a, b) => (a + 1) * width + (b + 1);
  const seen = new Set([key(0, 0)]);
  const queue = [{ a: 0, b: 0, str: '' }];
  for (let i = 0; i < queue.length; i++) {
    const { a, b, str } = queue[i];
    const accA = a !== -1 && dfaA.states[a].accept;
    const accB = b !== -1 && dfaB.states[b].accept;
    if (accA !== accB) return { string: str, side: accA ? 'A' : 'B' };
    for (let x = 0; x < atoms.length; x++) {
      const na = a === -1 ? -1 : dfaA.states[a].trans[x];
      const nb = b === -1 ? -1 : dfaB.states[b].trans[x];
      const k = key(na, nb);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push({ a: na, b: nb, str: str + String.fromCodePoint(atoms[x][0]) });
      }
    }
  }
  return null;
}

function equivPatterns(patternsA, patternsB) {
  const nfaA = nfaFromAsts(patternsA.map(parse));
  const nfaB = nfaFromAsts(patternsB.map(parse));
  const atoms = computeAlphabet([nfaA, nfaB]);
  const dfaA = nfaToDfa(nfaA, atoms);
  const dfaB = nfaToDfa(nfaB, atoms);
  const w = findWitness(dfaA, dfaB, atoms);
  if (!w) return { equiv: true, witness: null };
  return { equiv: false, witness: w.string, side: w.side };
}

function minimizePatterns(patterns) {
  const nfa = nfaFromAsts(patterns.map(parse));
  const atoms = computeAlphabet([nfa]);
  const dfa = nfaToDfa(nfa, atoms);
  const { complete, blocks, certificate } = minimizeDfa(dfa, atoms);
  return { complete, blocks, certificate, atoms };
}

module.exports = {
  nfaFromAsts,
  computeAlphabet,
  atomIndex,
  nfaToDfa,
  dfaMatch,
  compileAst,
  completeDfa,
  minimizeDfa,
  verifyMinimization,
  findWitness,
  equivPatterns,
  minimizePatterns,
};
