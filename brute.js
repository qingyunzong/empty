'use strict';

const { canonicalTokens, checkTrace } = require('./search');

// Independent brute-force enumerator used to cross-check the directed
// search in search.js. Enumerates every sequence in canonical order
// (length ascending, then lexicographic) and returns the first valid
// violating trace, with no pruning or feasibility heuristics.
function* enumerateSequences(tokens, length, prefix = []) {
  if (prefix.length === length) {
    yield prefix;
    return;
  }
  for (const token of tokens) {
    prefix.push(token);
    yield* enumerateSequences(tokens, length, prefix);
    prefix.pop();
  }
}

function bruteForce(spec) {
  const tokens = canonicalTokens(spec);
  for (let length = 2; length <= spec.maxLength; length++) {
    for (const sequence of enumerateSequences(tokens, length)) {
      const check = checkTrace(spec, sequence);
      if (check.valid && check.violation) {
        return {
          length,
          sequence: sequence.map((t) => ({ ...t })),
          violation: check.violation,
        };
      }
    }
  }
  return null;
}

module.exports = { bruteForce, enumerateSequences };
