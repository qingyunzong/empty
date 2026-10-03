// Independent reference implementation: tries every permutation of the
// events, filters by the constraint edges, and applies the same
// commutation-closure validity. Used to cross-check the main checker on
// small histories (<= 8 operations).

import { pairKey, validUpToCommutation } from './semantics.js';

export function referenceCheck(events, edges, commutePairs, effects) {
  const n = events.length;
  const commKeySet = new Set(commutePairs.map(([u, v]) => pairKey(events[u].id, events[v].id)));

  // Cycle check via Kahn's algorithm: no permutation can satisfy a cycle.
  const indeg = new Array(n).fill(0);
  const adj = Array.from({ length: n }, () => []);
  for (const [u, v] of edges) {
    adj[u].push(v);
    indeg[v]++;
  }
  const queue = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let seen = 0;
  while (queue.length) {
    const u = queue.pop();
    seen++;
    for (const v of adj[u]) if (--indeg[v] === 0) queue.push(v);
  }
  if (seen < n) return { verdict: 'NON_LINEARIZABLE', serialization: null };

  const perm = [];
  const used = new Array(n).fill(false);

  function respectsEdges() {
    const pos = new Array(n);
    perm.forEach((node, i) => { pos[node] = i; });
    for (const [u, v] of edges) if (pos[u] >= pos[v]) return false;
    return true;
  }

  function* permute() {
    if (perm.length === n) {
      if (respectsEdges()) yield perm.slice();
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      perm.push(i);
      yield* permute();
      perm.pop();
      used[i] = false;
    }
  }

  for (const p of permute()) {
    const seq = p.map((i) => events[i]);
    if (validUpToCommutation(seq, commKeySet, effects)) {
      return { verdict: 'LINEARIZABLE', serialization: p.map((i) => events[i].id) };
    }
  }
  return { verdict: 'NON_LINEARIZABLE', serialization: null };
}
