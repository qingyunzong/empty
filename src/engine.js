import { VM, DROPPED } from './vm.js';
import { ProcessingError } from './errors.js';

// Batch engine: processes records in batches, writes a checkpoint at the
// start of every batch (via onState) and commits the batch atomically at its
// end. A ProcessingError anywhere in a batch rolls the whole batch back to
// the last checkpoint; already-committed batches are never touched.
export class Engine {
  constructor(program, { batchSize = 10, crashAfter = null } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1) {
      throw new RangeError('batchSize must be a positive integer');
    }
    this.vm = new VM(program, { crashAfter });
    this.batchSize = batchSize;
  }

  // records: array of input records (plain objects).
  // state:   optional previously persisted { committed, results, batches }.
  // onState: optional callback invoked with the full persistable state at
  //          every checkpoint (batch start) and every commit (batch end).
  run(records, { state = null, onState = null } = {}) {
    const results = state ? state.results.map((r) => ({ ...r })) : [];
    const batches = state ? state.batches.map((b) => ({ ...b })) : [];
    let committed = state ? state.committed : 0;
    if (committed > records.length) {
      throw new Error(
        `State commits ${committed} records but input only has ${records.length}`,
      );
    }

    const emit = (phase) => {
      if (onState) {
        onState({
          phase,
          committed,
          results: results.map((r) => ({ ...r })),
          batches: batches.map((b) => ({ ...b })),
        });
      }
    };

    let index = committed;
    while (index < records.length) {
      const end = Math.min(index + this.batchSize, records.length);
      emit('checkpoint');
      const batchResults = [];
      try {
        for (let i = index; i < end; i += 1) {
          const out = this.vm.execRecord(records[i], i);
          if (out !== DROPPED) batchResults.push({ seq: i, record: out });
        }
      } catch (err) {
        if (err instanceof ProcessingError) {
          // Roll back the entire batch: batchResults is discarded and the
          // committed boundary stays exactly where the checkpoint left it.
          return {
            ok: false,
            error: { type: err.type, message: err.message, seq: err.seq },
            committedBoundary: committed,
            records: results,
            batches,
          };
        }
        throw err;
      }
      results.push(...batchResults);
      batches.push({
        index: batches.length,
        startSeq: index,
        endSeq: end - 1,
        count: end - index,
        committed: true,
      });
      committed = end;
      index = end;
      emit('committed');
    }
    return { ok: true, records: results, batches, committed };
  }
}
