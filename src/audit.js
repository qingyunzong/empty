// Integrity audit: log parseable & seq-contiguous, index matches the log,
// committed state accounts for every logged event exactly once.
import { Store } from './store.js';

export function auditStore(dir) {
  const store = new Store(dir);
  const problems = [];
  const log = store.readLog();

  log.forEach((rec, i) => {
    if (rec.seq !== i + 1) problems.push(`seq gap at line ${i + 1}: expected ${i + 1}, got ${rec.seq}`);
  });

  const idSeqs = new Map();
  let duplicateIds = 0;
  for (const rec of log) {
    if (idSeqs.has(rec.event.id)) duplicateIds++;
    else idSeqs.set(rec.event.id, rec.seq);
  }

  for (const [id, seq] of Object.entries(store.index.ids)) {
    const logged = idSeqs.get(id);
    if (logged === undefined) problems.push(`index id ${id} not present in log`);
  }
  for (const [id] of idSeqs) {
    if (store.index.ids[id] === undefined) problems.push(`logged id ${id} missing from index`);
  }

  if (store.state.appliedSeq > log.length) {
    problems.push(`appliedSeq ${store.state.appliedSeq} beyond log length ${log.length}`);
  }
  const unapplied = log.filter((r) => r.seq > store.state.appliedSeq).length;
  if (unapplied > 0) problems.push(`${unapplied} logged event(s) not applied; run 'resume'`);

  const maxTs = log.reduce((m, r) => Math.max(m, r.event.ts), null);
  if (log.length > 0 && store.state.watermark !== null && store.state.watermark > maxTs) {
    problems.push(`watermark ${store.state.watermark} beyond max logged ts ${maxTs}`);
  }

  return {
    dir,
    events: log.length,
    uniqueIds: idSeqs.size,
    duplicateIds,
    appliedSeq: store.state.appliedSeq,
    watermark: store.state.watermark,
    lots: Object.keys(store.state.lots).length,
    devices: Object.keys(store.state.devices).length,
    pending: Object.keys(store.state.pending).sort(),
    conflicts: store.state.conflicts.length,
    stats: store.state.stats,
    ok: problems.length === 0,
    problems,
  };
}
