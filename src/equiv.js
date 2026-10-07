'use strict';

const { NUM_SYMBOLS } = require('./automata');
const { ALPHABET } = require('./tokenize');

// Equivalence of two canonical complete DFAs over the same alphabet.
// Returns { equiv, witness } where witness is an array of token strings:
// the shortest divergent token string; ties broken by 5-tuple lexicographic
// order (BFS explores symbols in canonical alphabet order).
function equivalence(dfaA, dfaB) {
  const key = (a, b) => a * dfaB.n + b;
  const seen = new Set([key(dfaA.start, dfaB.start)]);
  const queue = [{ a: dfaA.start, b: dfaB.start, path: [] }];
  let head = 0;
  while (head < queue.length) {
    const { a, b, path } = queue[head++];
    if (dfaA.accept[a] !== dfaB.accept[b]) return { equiv: false, witness: path };
    for (let sym = 0; sym < NUM_SYMBOLS; sym++) {
      const na = dfaA.table[a][sym];
      const nb = dfaB.table[b][sym];
      const k = key(na, nb);
      if (!seen.has(k)) {
        seen.add(k);
        queue.push({ a: na, b: nb, path: [...path, ALPHABET[sym]] });
      }
    }
  }
  return { equiv: true, witness: null };
}

module.exports = { equivalence };
