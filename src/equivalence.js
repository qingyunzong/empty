import { ValidationError } from "./dfa.js";

function pairKey(a, b) {
  return JSON.stringify([a, b]);
}

export function compareDfas(oldDfa, newDfa, m = Infinity) {
  if (m !== Infinity && (!Number.isInteger(m) || m < 0)) {
    throw new ValidationError(`step bound m must be a non-negative integer, got ${JSON.stringify(m)}`);
  }
  const oldAlphabet = [...oldDfa.alphabet].sort();
  const newAlphabet = [...newDfa.alphabet].sort();
  if (oldAlphabet.length !== newAlphabet.length || oldAlphabet.some((s, i) => s !== newAlphabet[i])) {
    throw new ValidationError("old and new machines must share the same alphabet");
  }
  const alphabet = oldAlphabet;

  const visited = new Set([pairKey(oldDfa.start, newDfa.start)]);
  let frontier = [[oldDfa.start, newDfa.start, []]];
  const divergentPairs = [];
  let witness = null;

  while (frontier.length > 0) {
    const next = [];
    for (const [oldState, newState, path] of frontier) {
      if (oldDfa.risk[oldState] !== newDfa.risk[newState]) {
        divergentPairs.push([oldState, newState]);
        if (witness === null) {
          witness = path;
        }
      }
      if (path.length >= m) {
        continue;
      }
      for (const symbol of alphabet) {
        const nextOld = oldDfa.transitions[oldState][symbol];
        const nextNew = newDfa.transitions[newState][symbol];
        const key = pairKey(nextOld, nextNew);
        if (!visited.has(key)) {
          visited.add(key);
          next.push([nextOld, nextNew, [...path, symbol]]);
        }
      }
    }
    frontier = next;
  }

  return {
    equal: divergentPairs.length === 0,
    witness,
    divergentPairs,
  };
}
