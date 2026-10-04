// Bidirectional offline sync between two stores (edge gateway <-> trace DB).
// Both sides exchange the union of events by id, then deterministically
// rebuild from the merged set, so the two stores converge to identical state.
import fs from 'node:fs';
import { Store, makeApplier } from './store.js';
import { finalizeConflicts } from './store.js';
import { recoverAndFinalize, DEFAULT_WINDOW_MS } from './engine.js';

function appendRaw(store, events) {
  const startSeq = store.readLog().length;
  const fd = fs.openSync(store.logPath, 'a');
  try {
    events.forEach((event, i) => {
      fs.writeSync(fd, JSON.stringify({ seq: startSeq + i + 1, event }) + '\n');
    });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function syncStores(dirA, dirB, { window = DEFAULT_WINDOW_MS } = {}) {
  const a = new Store(dirA);
  const b = new Store(dirB);
  recoverAndFinalize(a, { window });
  recoverAndFinalize(b, { window });

  const logA = a.readLog().map((r) => r.event);
  const logB = b.readLog().map((r) => r.event);
  const idsA = new Set(logA.map((e) => e.id));
  const idsB = new Set(logB.map((e) => e.id));
  const toB = logA.filter((e) => !idsB.has(e.id));
  const toA = logB.filter((e) => !idsA.has(e.id));

  if (toA.length > 0) appendRaw(a, toA);
  if (toB.length > 0) appendRaw(b, toB);

  // Deterministic rebuild from the union on both sides -> convergence.
  for (const store of [a, b]) {
    store.rebuild(makeApplier(store.state, { window }));
    const all = store.readLog().map((r) => r.event);
    finalizeConflicts(store.state, all);
    store.persistState();
  }

  return {
    sentAB: toB.length,
    sentBA: toA.length,
    events: a.readLog().length,
    converged: JSON.stringify(a.state) === JSON.stringify(b.state),
    pending: Object.keys(a.state.pending).sort(),
    conflicts: a.state.conflicts,
  };
}
