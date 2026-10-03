import { tokenize } from '../src/tokenize.js';

// Deterministic PRNG so the cross-check tests are reproducible.
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference implementation: enumerate every ordered token window in every
// reason and keep those matching (first, second) within slop.
export function bruteForceNear(nodes, first, second, slop) {
  const result = new Map();
  for (const node of nodes) {
    const tokens = tokenize(node.reason ?? '');
    const pairs = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== first) continue;
      for (let j = i + 1; j < tokens.length; j++) {
        if (j - i - 1 > slop) break;
        if (tokens[j] === second) pairs.push([i, j]);
      }
    }
    if (pairs.length > 0) result.set(node.id, pairs);
  }
  return result;
}

export function randomReason(rand, vocab, maxLen) {
  const len = 1 + Math.floor(rand() * maxLen);
  const words = [];
  for (let i = 0; i < len; i++) words.push(vocab[Math.floor(rand() * vocab.length)]);
  return words.join(' ');
}
