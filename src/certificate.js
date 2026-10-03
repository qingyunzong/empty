import crypto from 'node:crypto';
import { canonical } from './canonical.js';
import { BusinessError, CorruptionError } from './errors.js';

// SHA256 lineage certificate of a batch: hash over the canonical form of
// {id, weight, status, parents:[parent cert hashes sorted]}. A batch's
// certificate therefore commits to its entire ancestry closure.
export function certificateFor(state, id) {
  const memo = new Map();
  const visiting = new Set();
  const cert = (batchId) => {
    if (memo.has(batchId)) return memo.get(batchId);
    if (visiting.has(batchId)) {
      throw new CorruptionError(`cyclic ancestry detected involving batch ${batchId}`);
    }
    const batch = state.batches.get(batchId);
    if (!batch) throw new BusinessError(`unknown batch: ${batchId}`);
    visiting.add(batchId);
    const parents = batch.parents.map(cert).sort();
    visiting.delete(batchId);
    const hash = crypto
      .createHash('sha256')
      .update(canonical({ id: batch.id, weight: batch.weight, status: batch.status, parents }))
      .digest('hex');
    memo.set(batchId, hash);
    return hash;
  };
  return cert(id);
}

export function certificatesForAll(state) {
  const out = {};
  for (const id of [...state.batches.keys()].sort()) out[id] = certificateFor(state, id);
  return out;
}
