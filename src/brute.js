'use strict';

// Independent reference implementation: naive exhaustive permutation
// enumeration with no pruning. Used by the test-suite to cross-check the
// solver for n <= 8. Deliberately shares only the state machine
// (src/model.js) with the solver.

const { createState, applyCommand } = require('./model');
const { compareOpIds } = require('./solver');

// A permutation (array of commands) is valid iff:
//   - interval order: for every pair a,b with a.end <= b.start, a precedes b
//   - depends: every dependency (present in the command set) precedes its dependent
//   - the account state machine accepts every command in sequence
function isValidPermutation(permutation, balances) {
  const position = new Map(permutation.map((cmd, index) => [cmd.opId, index]));
  const present = new Set(permutation.map((cmd) => cmd.opId));
  for (const a of permutation) {
    for (const b of permutation) {
      if (a !== b && a.end <= b.start && position.get(a.opId) > position.get(b.opId)) {
        return false;
      }
    }
    for (const dep of a.depends) {
      if (present.has(dep) && position.get(dep) > position.get(a.opId)) return false;
    }
  }
  const state = createState(balances);
  for (const cmd of permutation) {
    if (applyCommand(state, cmd) !== null) return false;
  }
  return true;
}

// Lexicographically smallest valid permutation (opIds), or null.
// Permutations are generated over opIds sorted ascending, so enumeration
// order is lexicographic and the first valid permutation is the minimum.
function bruteForceSchedule(commands, balances) {
  const sorted = [...commands].sort((a, b) => compareOpIds(a.opId, b.opId));
  const used = new Array(sorted.length).fill(false);
  const permutation = [];

  function enumerate() {
    if (permutation.length === sorted.length) {
      return isValidPermutation(permutation, balances);
    }
    for (let i = 0; i < sorted.length; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      permutation.push(sorted[i]);
      if (enumerate()) return true;
      permutation.pop();
      used[i] = false;
    }
    return false;
  }

  return enumerate() ? permutation.map((cmd) => cmd.opId) : null;
}

module.exports = { bruteForceSchedule, isValidPermutation };
