'use strict';

const { derivMatch } = require('./regex');
const { compileFlow } = require('./automata');

// BFS over the product automaton; missing transitions are a shared dead sink.
// Events are explored in sorted order, so the witness is the shortest and,
// among shortest, lexicographically smallest distinguishing string.
function productWitness(dfa1, dfa2, alphabet) {
  const step = (dfa, s, a) => (s === -1 ? -1 : (dfa.trans[s].get(a) ?? -1));
  const accepts = (dfa, s) => s !== -1 && dfa.finals.has(s);

  const seen = new Set([`${dfa1.start},${dfa2.start}`]);
  const queue = [{ s1: dfa1.start, s2: dfa2.start, path: [] }];
  while (queue.length) {
    const { s1, s2, path } = queue.shift();
    if (accepts(dfa1, s1) !== accepts(dfa2, s2)) return path;
    for (const a of alphabet) {
      const n1 = step(dfa1, s1, a);
      const n2 = step(dfa2, s2, a);
      if (n1 === -1 && n2 === -1) continue;
      const key = `${n1},${n2}`;
      if (!seen.has(key)) { seen.add(key); queue.push({ s1: n1, s2: n2, path: [...path, a] }); }
    }
  }
  return null;
}

// Independent enumerator: enumerates strings over the alphabet in
// (length, lexicographic) order and tests membership with Brzozowski
// derivatives only -- no DFA code involved. Must reproduce the witness.
function enumerateDistinguisher(ast1, ast2, alphabet, maxLen) {
  let frontier = [[]];
  for (let len = 0; len <= maxLen; len++) {
    const next = [];
    for (const s of frontier) {
      if (derivMatch(ast1, s) !== derivMatch(ast2, s)) return s;
      if (len < maxLen) for (const a of alphabet) next.push([...s, a]);
    }
    frontier = next;
  }
  return null;
}

function equivFlows(src1, src2) {
  const f1 = compileFlow(src1);
  const f2 = compileFlow(src2);
  const alphabet = [...new Set([...f1.alphabet, ...f2.alphabet])].sort();
  const witness = productWitness(f1.dfa, f2.dfa, alphabet);
  if (witness === null) return { equiv: true, witness: null, reproduced: null };
  const found = enumerateDistinguisher(f1.ast, f2.ast, alphabet, witness.length);
  const reproduced = found !== null && JSON.stringify(found) === JSON.stringify(witness);
  return { equiv: false, witness, reproduced };
}

module.exports = { equivFlows, productWitness, enumerateDistinguisher };
