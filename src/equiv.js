'use strict';

const { compileFlow } = require('./flow');

function simulateWord(dfa, word) {
  let s = dfa.start;
  for (const e of word) {
    const t = dfa.trans[s].get(e);
    if (t === undefined) return false;
    s = t;
  }
  return dfa.accept.has(s);
}

// BFS over the product of both DFAs; yields the shortest (then
// lexicographically smallest, alphabet sorted) distinguishing word.
function findDistinguisher(dfaA, dfaB, alphabet) {
  const sorted = [...alphabet].sort();
  const seen = new Set([`${dfaA.start},${dfaB.start}`]);
  const queue = [[dfaA.start, dfaB.start, []]];
  while (queue.length) {
    const [a, b, word] = queue.shift();
    const accA = a >= 0 && dfaA.accept.has(a);
    const accB = b >= 0 && dfaB.accept.has(b);
    if (accA !== accB) {
      return { events: word, acceptedBy: accA ? 'left' : 'right' };
    }
    for (const sym of sorted) {
      const ta = a >= 0 ? dfaA.trans[a].get(sym) : undefined;
      const tb = b >= 0 ? dfaB.trans[b].get(sym) : undefined;
      const na = ta === undefined ? -1 : ta;
      const nb = tb === undefined ? -1 : tb;
      const key = `${na},${nb}`;
      if (!seen.has(key)) {
        seen.add(key);
        queue.push([na, nb, [...word, sym]]);
      }
    }
  }
  return null;
}

// Independent enumerator: enumerates every word over the alphabet in
// length-lexicographic order and re-simulates both DFAs from scratch.
function enumerateDistinguisher(dfaA, dfaB, alphabet, maxLen) {
  const sorted = [...alphabet].sort();
  let word = [];
  for (;;) {
    const accA = simulateWord(dfaA, word);
    const accB = simulateWord(dfaB, word);
    if (accA !== accB) {
      return { events: [...word], acceptedBy: accA ? 'left' : 'right' };
    }
    let i = word.length - 1;
    while (i >= 0 && word[i] === sorted[sorted.length - 1]) i -= 1;
    if (i < 0) {
      if (word.length >= maxLen) return null;
      word = new Array(word.length + 1).fill(sorted[0]);
    } else {
      word[i] = sorted[sorted.indexOf(word[i]) + 1];
      for (let j = i + 1; j < word.length; j += 1) word[j] = sorted[0];
    }
  }
}

function compareFlows(sourceA, sourceB) {
  const left = compileFlow(sourceA);
  const right = compileFlow(sourceB);
  const alphabet = [...new Set([...left.alphabet, ...right.alphabet])].sort();
  const witness = findDistinguisher(left.dfa, right.dfa, alphabet);
  if (witness === null) return { equiv: true, alphabet };
  const bound = left.dfa.states * right.dfa.states;
  const reproduced = enumerateDistinguisher(left.dfa, right.dfa, alphabet, bound);
  return {
    equiv: false,
    alphabet,
    witness,
    enumerator: {
      bound,
      witness: reproduced,
      reproduced:
        reproduced !== null
        && JSON.stringify(reproduced.events) === JSON.stringify(witness.events),
    },
  };
}

module.exports = { compareFlows, findDistinguisher, enumerateDistinguisher, simulateWord };
