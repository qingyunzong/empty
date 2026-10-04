'use strict';

const { MAX_CP } = require('./regex');

// ---------------------------------------------------------------------------
// NFA (Thompson construction, transitions labelled by code point intervals)
// ---------------------------------------------------------------------------

function buildNfa(ast) {
  const states = [];
  const newState = () => {
    states.push({ eps: [], trans: [] });
    return states.length - 1;
  };
  const addEps = (from, to) => states[from].eps.push(to);
  const addTrans = (from, lo, hi, to) => states[from].trans.push({ lo, hi, to });

  function build(node) {
    switch (node.type) {
      case 'empty': {
        const s = newState();
        const t = newState();
        addEps(s, t);
        return { s, t };
      }
      case 'char': {
        const s = newState();
        const t = newState();
        addTrans(s, node.code, node.code, t);
        return { s, t };
      }
      case 'class': {
        const s = newState();
        const t = newState();
        for (const [lo, hi] of node.intervals) addTrans(s, lo, hi, t);
        return { s, t };
      }
      case 'concat': {
        let first = null;
        let prev = null;
        for (const part of node.parts) {
          const frag = build(part);
          if (!first) first = frag;
          else addEps(prev.t, frag.s);
          prev = frag;
        }
        if (!first) return build({ type: 'empty' });
        return { s: first.s, t: prev.t };
      }
      case 'union': {
        const s = newState();
        const t = newState();
        for (const opt of node.options) {
          const frag = build(opt);
          addEps(s, frag.s);
          addEps(frag.t, t);
        }
        return { s, t };
      }
      case 'star': {
        const s = newState();
        const t = newState();
        const frag = build(node.child);
        addEps(s, t);
        addEps(s, frag.s);
        addEps(frag.t, frag.s);
        addEps(frag.t, t);
        return { s, t };
      }
      case 'opt': {
        const s = newState();
        const t = newState();
        const frag = build(node.child);
        addEps(s, t);
        addEps(s, frag.s);
        addEps(frag.t, t);
        return { s, t };
      }
      default:
        throw new Error(`unknown AST node type: ${node.type}`);
    }
  }

  const { s, t } = build(ast);
  return { states, start: s, accept: t };
}

// Combine several NFAs into one NFA recognising the union language.
function combineNfas(nfas) {
  const states = [{ eps: [], trans: [] }];
  const start = 0;
  const accepts = [];
  for (const nfa of nfas) {
    const off = states.length;
    for (const st of nfa.states) {
      states.push({
        eps: st.eps.map((e) => e + off),
        trans: st.trans.map((tr) => ({ lo: tr.lo, hi: tr.hi, to: tr.to + off })),
      });
    }
    states[start].eps.push(nfa.start + off);
    accepts.push(nfa.accept + off);
  }
  const accept = states.length;
  states.push({ eps: [], trans: [] });
  for (const a of accepts) states[a].eps.push(accept);
  return { states, start, accept };
}

// Global alphabet: atomic code point intervals induced by every transition
// label of the given NFAs. Covers [0, MAX_CP] completely.
function computeAlphabet(nfas) {
  const cuts = new Set([0, MAX_CP + 1]);
  for (const nfa of nfas) {
    for (const st of nfa.states) {
      for (const tr of st.trans) {
        cuts.add(tr.lo);
        cuts.add(tr.hi + 1);
      }
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const alphabet = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    alphabet.push([sorted[i], sorted[i + 1] - 1]);
  }
  return alphabet;
}

// ---------------------------------------------------------------------------
// DFA (subset construction over the shared interval alphabet)
// ---------------------------------------------------------------------------

function epsClosure(nfa, ids) {
  const seen = new Set(ids);
  const stack = [...ids];
  while (stack.length) {
    const id = stack.pop();
    for (const next of nfa.states[id].eps) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function nfaToDfa(nfa, alphabet) {
  const keyOf = (set) => [...set].sort((a, b) => a - b).join(',');
  const dfaStates = [];
  const index = new Map();
  const queue = [];

  function add(set) {
    const key = keyOf(set);
    let idx = index.get(key);
    if (idx === undefined) {
      idx = dfaStates.length;
      index.set(key, idx);
      const arr = [...set];
      dfaStates.push({ set: arr, accept: arr.includes(nfa.accept), trans: null });
      queue.push(idx);
    }
    return idx;
  }

  add(epsClosure(nfa, [nfa.start]));
  while (queue.length) {
    const idx = queue.pop();
    const st = dfaStates[idx];
    st.trans = alphabet.map(([lo, hi]) => {
      const next = new Set();
      for (const s of st.set) {
        for (const tr of nfa.states[s].trans) {
          if (tr.lo <= lo && hi <= tr.hi) {
            for (const c of epsClosure(nfa, [tr.to])) next.add(c);
          }
        }
      }
      return add(next);
    });
  }

  return {
    alphabet,
    start: 0,
    states: dfaStates.map((s) => ({ accept: s.accept, trans: s.trans })),
  };
}

function findGroup(alphabet, cp) {
  let lo = 0;
  let hi = alphabet.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = alphabet[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return mid;
  }
  return -1;
}

function simulate(dfa, str, start) {
  let s = start === undefined ? dfa.start : start;
  for (const ch of str) {
    const g = findGroup(dfa.alphabet, ch.codePointAt(0));
    if (g === -1) return false;
    s = dfa.states[s].trans[g];
  }
  return dfa.states[s].accept;
}

// ---------------------------------------------------------------------------
// DFA minimization (partition refinement) with a verifiable certificate
// ---------------------------------------------------------------------------

function minimizeDfa(dfa) {
  const n = dfa.states.length;
  // Initial partition: non-accepting vs accepting.
  let blockOf = dfa.states.map((s) => (s.accept ? 1 : 0));
  let numBlocks = n === 0 ? 0 : Math.max(...blockOf) + 1;

  for (;;) {
    const sigIndex = new Map();
    const next = new Array(n);
    let count = 0;
    for (let s = 0; s < n; s++) {
      const sig = blockOf[s] + '|' + dfa.states[s].trans.map((t) => blockOf[t]).join(',');
      let id = sigIndex.get(sig);
      if (id === undefined) {
        id = count++;
        sigIndex.set(sig, id);
      }
      next[s] = id;
    }
    if (count === numBlocks) break;
    blockOf = next;
    numBlocks = count;
  }

  // Deterministic block ordering: sort by smallest member state id.
  const blocks = [];
  for (let s = 0; s < n; s++) {
    const b = blockOf[s];
    if (!blocks[b]) blocks[b] = [];
    blocks[b].push(s);
  }
  blocks.sort((a, b) => a[0] - b[0]);
  const finalBlockOf = new Array(n);
  blocks.forEach((members, i) => {
    for (const s of members) finalBlockOf[s] = i;
  });

  const minStates = blocks.map((members) => {
    const rep = members[0];
    return {
      accept: dfa.states[rep].accept,
      trans: dfa.states[rep].trans.map((t) => finalBlockOf[t]),
    };
  });
  const minDfa = {
    alphabet: dfa.alphabet,
    start: finalBlockOf[dfa.start],
    states: minStates,
  };

  const certificate = buildCertificate(dfa, blocks, finalBlockOf, minDfa);
  return { minDfa, certificate };
}

// BFS on the product of the minimized DFA with itself: shortest, then
// numerically smallest (by code point) string separating states a and b.
function findSeparator(minDfa, a0, b0) {
  const visited = new Set([a0 + ',' + b0]);
  const queue = [{ a: a0, b: b0, path: '' }];
  while (queue.length) {
    const { a, b, path } = queue.shift();
    if (minDfa.states[a].accept !== minDfa.states[b].accept) return path;
    for (let g = 0; g < minDfa.alphabet.length; g++) {
      const na = minDfa.states[a].trans[g];
      const nb = minDfa.states[b].trans[g];
      const key = na + ',' + nb;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ a: na, b: nb, path: path + String.fromCodePoint(minDfa.alphabet[g][0]) });
      }
    }
  }
  return null;
}

function buildCertificate(dfa, blocks, blockOf, minDfa) {
  const blockTrans = blocks.map((members) => {
    const rep = members[0];
    return dfa.states[rep].trans.map((t) => blockOf[t]);
  });
  const separators = {};
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const sep = findSeparator(minDfa, i, j);
      if (sep !== null) separators[`${i},${j}`] = sep;
    }
  }
  return {
    alphabet: dfa.alphabet,
    stateCount: dfa.states.length,
    blocks,
    startBlock: blockOf[dfa.start],
    acceptBlocks: blocks
      .map((members, i) => (dfa.states[members[0]].accept ? i : -1))
      .filter((i) => i >= 0),
    blockTrans,
    separators,
  };
}

// Verify a minimization certificate against the original DFA:
//  1. blocks form an exact partition of the DFA states;
//  2. every block is consistent (same acceptance, transitions land in the
//     same target block as recorded) -- a bisimulation, so states inside a
//     block are equivalent;
//  3. start/accept blocks match;
//  4. every pair of distinct blocks carries a separator string that really
//     distinguishes their representatives -- so distinct blocks are
//     inequivalent. (2)+(4) prove the partition is the Myhill-Nerode
//     equivalence, i.e. the minimization is correct.
function verifyCertificate(dfa, cert) {
  const fail = (reason) => ({ valid: false, reason });
  const n = dfa.states.length;
  if (cert.stateCount !== n) return fail('stateCount mismatch');
  if (JSON.stringify(cert.alphabet) !== JSON.stringify(dfa.alphabet)) {
    return fail('alphabet mismatch');
  }
  const flat = cert.blocks.flat().slice().sort((a, b) => a - b);
  if (flat.length !== n || flat.some((v, i) => v !== i)) {
    return fail('blocks are not a partition of the states');
  }
  const blockOf = new Array(n);
  cert.blocks.forEach((members, i) => {
    for (const s of members) blockOf[s] = i;
  });
  for (let i = 0; i < cert.blocks.length; i++) {
    const members = cert.blocks[i];
    const rep = members[0];
    for (const s of members) {
      if (dfa.states[s].accept !== dfa.states[rep].accept) {
        return fail(`block ${i} mixes accepting and non-accepting states`);
      }
      for (let g = 0; g < dfa.alphabet.length; g++) {
        const target = blockOf[dfa.states[s].trans[g]];
        if (target !== cert.blockTrans[i][g]) {
          return fail(`block ${i} transition ${g} is inconsistent`);
        }
      }
    }
  }
  if (cert.startBlock !== blockOf[dfa.start]) return fail('startBlock mismatch');
  const acceptBlocks = cert.blocks
    .map((members, i) => (dfa.states[members[0]].accept ? i : -1))
    .filter((i) => i >= 0);
  if (JSON.stringify(acceptBlocks) !== JSON.stringify(cert.acceptBlocks)) {
    return fail('acceptBlocks mismatch');
  }
  for (const [pair, sep] of Object.entries(cert.separators)) {
    const [i, j] = pair.split(',').map(Number);
    const a = simulate(dfa, sep, cert.blocks[i][0]);
    const b = simulate(dfa, sep, cert.blocks[j][0]);
    if (a === b) return fail(`separator for blocks ${pair} does not separate`);
  }
  const pairCount = (cert.blocks.length * (cert.blocks.length - 1)) / 2;
  if (Object.keys(cert.separators).length !== pairCount) {
    return fail('missing separators for some block pairs');
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Equivalence of two DFAs over a shared alphabet, with witness
// ---------------------------------------------------------------------------

// BFS over the product automaton. Yields the shortest string in the
// symmetric difference; ties broken by numerically smallest code points
// (alphabet groups are scanned in ascending order).
function equivDfas(dfa1, dfa2) {
  const visited = new Set([dfa1.start + ',' + dfa2.start]);
  const queue = [{ a: dfa1.start, b: dfa2.start, path: '' }];
  while (queue.length) {
    const { a, b, path } = queue.shift();
    if (dfa1.states[a].accept !== dfa2.states[b].accept) {
      return { equiv: false, witness: path };
    }
    for (let g = 0; g < dfa1.alphabet.length; g++) {
      const na = dfa1.states[a].trans[g];
      const nb = dfa2.states[b].trans[g];
      const key = na + ',' + nb;
      if (!visited.has(key)) {
        visited.add(key);
        queue.push({ a: na, b: nb, path: path + String.fromCodePoint(dfa1.alphabet[g][0]) });
      }
    }
  }
  return { equiv: true, witness: null };
}

module.exports = {
  buildNfa,
  combineNfas,
  computeAlphabet,
  nfaToDfa,
  simulate,
  minimizeDfa,
  verifyCertificate,
  equivDfas,
};
