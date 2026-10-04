import path from 'node:path';
import { Wal } from './wal.js';
import { GENESIS_HASH } from './util.js';

// Naive reference: replay valid committed WAL records in sequence-number
// order from scratch. Used by tests as the ground-truth oracle for recovery.
export function referenceReplay(dir) {
  const wal = new Wal(path.join(dir, 'wal.log'));
  const { committed } = wal.scan();
  const sorted = [...committed].sort((a, b) => a.record.seq - b.record.seq);
  const records = new Map();
  const byKey = new Map();
  const byClient = new Map();
  let lastHash = GENESIS_HASH;
  let lastSeq = 0;
  for (const { record, hash } of sorted) {
    const rec = { ...record, hash };
    if (rec.type === 'correct') {
      const target = records.get(rec.correctsRecordId);
      if (target) target.invalidatedBy = rec.recordId;
    }
    records.set(rec.recordId, rec);
    byClient.set(rec.clientRecordId, rec.recordId);
    const key = `${rec.lotId} ${rec.testCode}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(rec.recordId);
    lastHash = hash;
    lastSeq = rec.seq;
  }
  const heads = {};
  for (const [key, ids] of byKey) {
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const rec = records.get(ids[i]);
      if (!rec.invalidatedBy) {
        heads[key] = { recordId: rec.recordId, judgment: rec.judgment, seq: rec.seq };
        break;
      }
    }
  }
  return {
    lastSeq,
    lastHash,
    heads,
    recordCount: records.size,
    clientCount: byClient.size,
  };
}
