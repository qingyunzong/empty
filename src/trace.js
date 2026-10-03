// Orchestration shared by the CLI and tests: load batches into the store as
// one transaction, then record the solve outcome (genealogy edges plus all
// propagation conclusions) as a second transaction.

import { TraceStore } from './store.js';
import { solve } from './solver.js';

export function runTrace(model, { budget, store = new TraceStore() } = {}) {
  store.begin('load-input');
  for (const b of model.batches.values()) store.addBatch(b);
  store.commit();

  const result = solve(model, { budget });

  store.begin('solve');
  for (const e of result.edges) store.addEdge(e);
  store.setDerived('propagation', result.derived);
  store.setDerived('lastResult', {
    status: result.status,
    proof: result.proof,
    pending: result.pending,
    stats: result.stats,
  });
  store.commit();

  return { store, result };
}
