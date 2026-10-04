'use strict';

const { Planner } = require('./planner');

// Bidirectional delta exchange between two terminal directories. Each op
// carries (term, counter); a terminal imports exactly the ops above its
// version vector. Conflicts are resolved during replay by version-vector
// dominance with a deterministic concurrent tie-break (see planner.resolveOps).
// Resource over-allocation after the merge is demoted to `pending`.

function exchange(dst, src) {
  const vv = dst.versionVector();
  const incoming = src.ops.filter((o) => (o.counter || 0) > (vv[o.term] || 0));
  if (incoming.length === 0) return 0;
  dst.ops = dst.ops.concat(incoming);
  dst.store.rewriteJournal(dst.ops);
  dst.rebuild();
  return incoming.length;
}

function syncPeers(dirA, dirB) {
  const a = Planner.open(dirA);
  const b = Planner.open(dirB);
  const importedByB = exchange(b, a);
  const importedByA = exchange(a, b);
  const ra = a.finishSync();
  const rb = b.finishSync();
  return {
    a: { term: a.meta.termId, imported: importedByA, vv: a.versionVector(), result: ra },
    b: { term: b.meta.termId, imported: importedByB, vv: b.versionVector(), result: rb }
  };
}

module.exports = { syncPeers };
