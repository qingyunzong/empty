// Linearizability checker for concurrent operation logs.
//
// Input: a list of log entries, each with the operation fields accepted by
// Ledger.apply plus:
//   id     - optional identifier (defaults to the entry index)
//   start  - invocation time (real-time order lower bound)
//   end    - response time   (real-time order upper bound)
//   result - 'ok' or an error code string ('E_LIMIT' | 'E_STATE' | 'E_EXPIRED')
//            (an object { error: code } is also accepted)
//
// Real-time precedence: op i must precede op j when end_i < start_j
// (strict; equal timestamps are treated as concurrent).
//
// Output: whether the log can be reordered into a legal serial history
// that respects precedence and reproduces every recorded result, plus one
// witness sequence (list of entry ids) when it can.

import { Ledger } from './limit.js';

function expectedError(entry) {
  const result = entry.result;
  if (result === undefined || result === null || result === 'ok') return null;
  if (typeof result === 'string') return result;
  if (typeof result === 'object' && typeof result.error === 'string') return result.error;
  return null;
}

function resultMatches(entry, applyFn) {
  const wantError = expectedError(entry);
  try {
    applyFn();
    return wantError === null;
  } catch (err) {
    return wantError !== null && err && err.code === wantError;
  }
}

export function checkLinearizable(entries, { defaultLimit = null, nodeBudget = 100000 } = {}) {
  const n = entries.length;
  const ids = entries.map((entry, i) => (entry.id !== undefined ? entry.id : i));

  // successors[i]: entries that must come after i (real-time order).
  const successors = entries.map(() => []);
  const predCount = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && entries[i].end !== undefined && entries[j].start !== undefined
          && entries[i].end < entries[j].start) {
        successors[i].push(j);
        predCount[j] += 1;
      }
    }
  }

  const placed = new Array(n).fill(false);
  let nodes = 0;
  let exhausted = false;

  function search(ledger, remaining, witness) {
    if (remaining === 0) return witness;
    nodes += 1;
    if (nodes > nodeBudget) {
      exhausted = true;
      return null;
    }
    for (let i = 0; i < n; i++) {
      if (placed[i] || predCount[i] > 0) continue;
      const next = ledger.clone();
      if (!resultMatches(entries[i], () => next.apply(entries[i]))) continue;
      placed[i] = true;
      for (const j of successors[i]) predCount[j] -= 1;
      witness.push(ids[i]);
      const found = search(next, remaining - 1, witness);
      if (found) return found;
      witness.pop();
      for (const j of successors[i]) predCount[j] += 1;
      placed[i] = false;
      if (exhausted) return null;
    }
    return null;
  }

  const witness = search(new Ledger(defaultLimit), n, []);
  if (witness) return { linearizable: true, witness, nodes };
  if (exhausted) return { linearizable: null, reason: 'node budget exhausted', nodes };
  return { linearizable: false, nodes };
}
