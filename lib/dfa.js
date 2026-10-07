'use strict';

// DFA: { alphabet: string[], start: number, trans: number[][] (state x charIdx -> state),
//        accept: boolean[] }. Transition function is total.

const { createHash } = require('node:crypto');

function keyOf(set) {
  return [...set].sort((a, b) => a - b).join(',');
}

// Subset construction from an NFA.
// nfa: { count, trans: Array<Array<{sym: string|null, to: number}>>, start, finals: number[] }
function determinize(nfa, alphabet) {
  const charIdx = new Map(alphabet.map((c, i) => [c, i]));
  const epsClosure = (states) => {
    const closure = new Set(states);
    const stack = [...states];
    while (stack.length) {
      const s = stack.pop();
      for (const e of nfa.trans[s]) {
        if (e.sym === null && !closure.has(e.to)) {
          closure.add(e.to);
          stack.push(e.to);
        }
      }
    }
    return closure;
  };

  const startSet = epsClosure([nfa.start]);
  const finals = new Set(nfa.finals);
  const ids = new Map([[keyOf(startSet), 0]]);
  const sets = [startSet];
  const trans = [];
  const accept = [];
  const queue = [startSet];

  while (queue.length) {
    const cur = queue.shift();
    const id = ids.get(keyOf(cur));
    accept[id] = [...cur].some((s) => finals.has(s));
    trans[id] = new Array(alphabet.length).fill(-1);
    for (const [c, ci] of charIdx) {
      const move = new Set();
      for (const s of cur) {
        for (const e of nfa.trans[s]) {
          if (e.sym === c) move.add(e.to);
        }
      }
      const tgt = epsClosure(move);
      const k = keyOf(tgt);
      if (!ids.has(k)) {
        ids.set(k, sets.length);
        sets.push(tgt);
        queue.push(tgt);
      }
      trans[id][ci] = ids.get(k);
    }
  }
  // Fill missing transitions with a sink state (keep the DFA total).
  let sink = -1;
  for (let s = 0; s < trans.length; s++) {
    for (let i = 0; i < alphabet.length; i++) {
      if (trans[s][i] === -1) {
        if (sink === -1) {
          sink = trans.length;
          trans.push(new Array(alphabet.length).fill(sink));
          accept.push(false);
        }
        trans[s][i] = sink;
      }
    }
  }
  return { alphabet: [...alphabet], start: 0, trans, accept };
}

function reachable(dfa) {
  const seen = new Set([dfa.start]);
  const stack = [dfa.start];
  while (stack.length) {
    const s = stack.pop();
    for (const t of dfa.trans[s]) {
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return seen;
}

function intersect(a, b) {
  const alphabet = a.alphabet;
  const start = [a.start, b.start];
  const ids = new Map([[start.join(','), 0]]);
  const trans = [];
  const accept = [];
  const queue = [start];
  while (queue.length) {
    const [sa, sb] = queue.shift();
    const id = ids.get(`${sa},${sb}`);
    accept[id] = a.accept[sa] && b.accept[sb];
    trans[id] = alphabet.map((c, i) => {
      const t = [a.trans[sa][i], b.trans[sb][i]];
      const k = t.join(',');
      if (!ids.has(k)) { ids.set(k, ids.size); queue.push(t); }
      return ids.get(k);
    });
  }
  return { alphabet: [...alphabet], start: 0, trans, accept };
}

function complement(dfa) {
  return {
    alphabet: [...dfa.alphabet],
    start: dfa.start,
    trans: dfa.trans.map((row) => [...row]),
    accept: dfa.accept.map((x) => !x),
  };
}

// Partition-refinement minimization; states renumbered in canonical BFS order.
function minimize(dfa) {
  const keep = reachable(dfa);
  const states = [...keep].sort((x, y) => x - y);
  const n = states.length;
  const oldIndex = new Map(states.map((s, i) => [s, i]));
  const acc = states.map((s) => dfa.accept[s]);
  const tr = states.map((s) => dfa.trans[s].map((t) => oldIndex.get(t)));
  const m = dfa.alphabet.length;

  let part = acc.map((a) => (a ? 1 : 0));
  for (;;) {
    const sig = new Map();
    const next = new Array(n);
    for (let s = 0; s < n; s++) {
      const key = part[s] + '|' + tr[s].map((t) => part[t]).join(',');
      if (!sig.has(key)) sig.set(key, sig.size);
      next[s] = sig.get(key);
    }
    if (sig.size === new Set(part).size) break;
    part = next;
  }

  const blocks = new Map();
  for (let s = 0; s < n; s++) {
    if (!blocks.has(part[s])) blocks.set(part[s], []);
    blocks.get(part[s]).push(s);
  }
  // Canonical order: BFS from the start block, ties by alphabet order.
  const blockOf = part;
  const startBlock = blockOf[oldIndex.get(dfa.start)];
  const blockIds = new Map([[startBlock, 0]]);
  const order = [startBlock];
  const queue = [startBlock];
  while (queue.length) {
    const b = queue.shift();
    const rep = blocks.get(b)[0];
    for (let i = 0; i < m; i++) {
      const tb = blockOf[tr[rep][i]];
      if (!blockIds.has(tb)) {
        blockIds.set(tb, blockIds.size);
        order.push(tb);
        queue.push(tb);
      }
    }
  }
  const size = order.length;
  const repOf = order.map((b) => blocks.get(b)[0]);
  const trans = repOf.map((rep) => tr[rep].map((t) => blockIds.get(blockOf[t])));
  const accept = repOf.map((rep) => acc[rep]);
  return { alphabet: [...dfa.alphabet], start: 0, trans, accept };
}

// BFS shortest accepted word; null if language is empty.
function shortestWitness(dfa) {
  if (dfa.accept[dfa.start]) return '';
  const prev = new Map([[dfa.start, null]]); // state -> [prevState, char]
  const queue = [dfa.start];
  while (queue.length) {
    const s = queue.shift();
    for (let i = 0; i < dfa.alphabet.length; i++) {
      const t = dfa.trans[s][i];
      if (prev.has(t)) continue;
      prev.set(t, [s, dfa.alphabet[i]]);
      if (dfa.accept[t]) {
        let word = '';
        for (let cur = t; prev.get(cur) !== null;) {
          const [p, c] = prev.get(cur);
          word = c + word;
          cur = p;
        }
        return word;
      }
      queue.push(t);
    }
  }
  return null;
}

function acceptCount(dfa) {
  return dfa.accept.reduce((n, a) => n + (a ? 1 : 0), 0);
}

// Canonical serialization of a minimized DFA; basis of the emptiness certificate.
function serialize(dfa) {
  const lines = [];
  lines.push(`A:${dfa.alphabet.join('')}`);
  lines.push(`N:${dfa.accept.length}`);
  lines.push(`S:${dfa.start}`);
  lines.push(`F:${dfa.accept.map((a, i) => (a ? i : -1)).filter((i) => i >= 0).join(',')}`);
  for (let s = 0; s < dfa.trans.length; s++) {
    lines.push(`T:${s}:${dfa.trans[s].join(',')}`);
  }
  return lines.join('\n');
}

function certHash(dfa) {
  return createHash('sha256').update(serialize(dfa)).digest('hex');
}

module.exports = {
  determinize, intersect, complement, minimize,
  shortestWitness, acceptCount, serialize, certHash, reachable,
};
