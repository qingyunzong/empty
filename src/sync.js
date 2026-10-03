// Two-terminal offline sync. Terminals exchange incremental batch records;
// conflicts are ordered by version vectors (happened-before wins; concurrent
// batches are ordered deterministically by (terminal, seq)). After merging,
// mold over-allocation is surfaced as `pending` — never as unsatisfiable.

import { Workspace } from './workspace.js';

function vectorEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  }
  return true;
}

// Merge a packet { vector, records } from a peer into `ws`.
export function mergePacket(ws, packet) {
  const applied = [];
  const skipped = [];
  const sorted = [...packet.records].sort((r1, r2) => {
    if (r1.origin.terminal !== r2.origin.terminal) {
      return r1.origin.terminal < r2.origin.terminal ? -1 : 1;
    }
    return r1.origin.seq - r2.origin.seq;
  });
  for (const rec of sorted) {
    const { terminal, seq } = rec.origin;
    if ((ws.vector[terminal] ?? 0) >= seq) {
      skipped.push(rec); // already have it (version vector)
      continue;
    }
    ws.applyBatch(rec.changes, { lockedMolds: rec.lockedMolds, origin: rec.origin });
    ws.vector[terminal] = seq;
    applied.push(rec);
  }
  ws.store.commitManifest(ws.manifest());
  return { applied: applied.length, skipped: skipped.length, pending: ws.state.pending };
}

// Bidirectional sync between two workspace directories.
export function syncWorkspaces(wsA, wsB) {
  let appliedAB = 0;
  let appliedBA = 0;
  // Exchange until both version vectors stop moving (two passes suffice for
  // pairwise sync, but loop keeps it honest for any transitive learning).
  for (let round = 0; round < 4; round++) {
    const beforeA = JSON.stringify(wsA.vector);
    const beforeB = JSON.stringify(wsB.vector);
    appliedAB += mergePacket(wsB, wsA.exportOps(wsB.vector)).applied;
    appliedBA += mergePacket(wsA, wsB.exportOps(wsA.vector)).applied;
    if (JSON.stringify(wsA.vector) === beforeA && JSON.stringify(wsB.vector) === beforeB) break;
  }
  return {
    appliedAB,
    appliedBA,
    pendingA: wsA.state.pending,
    pendingB: wsB.state.pending,
    vectorA: { ...wsA.vector },
    vectorB: { ...wsB.vector },
    converged: vectorEqual(wsA.vector, wsB.vector),
  };
}
