// Batch runner: processes records in batches. A checkpoint is written to the
// state file at the start of every batch (recording the indices successfully
// processed so far); after a batch completes, the commit is persisted
// atomically. A VMError anywhere in a batch rolls the whole batch back to the
// checkpoint: every correction emitted by that batch is revoked and the run
// reports the error plus the last committed boundary. A CrashError (from
// --crash N) propagates so the process dies before the next checkpoint; a
// rerun with the same state file resumes strictly after the last committed
// batch, so already-committed records are never corrected twice.

import fs from 'node:fs';
import { execute, CrashError } from './vm.js';

export { CrashError };

export function runPipeline({ records, code, batchSize = 10, statePath = null, crashAfter = null }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new RangeError('batchSize must be a positive integer');
  }
  let results = [];
  let batches = [];
  let committedThrough = -1;
  if (statePath && fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    results = state.results;
    batches = state.batches;
    committedThrough = state.committedThrough;
  }

  const counter = { count: 0 };
  const persist = (phase, batchStart = null) => {
    if (!statePath) return;
    const processedIndices = [];
    for (let index = 0; index <= committedThrough; index++) processedIndices.push(index);
    const state = {
      version: 1,
      phase,
      committedThrough,
      processedIndices,
      pendingBatch: batchStart === null ? null : { startIndex: batchStart },
      results,
      batches,
    };
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  };

  let index = committedThrough + 1;
  while (index < records.length) {
    const end = Math.min(index + batchSize, records.length);
    persist('checkpoint', index);
    const batchOutput = [];
    try {
      for (let recordIndex = index; recordIndex < end; recordIndex++) {
        const working = structuredClone(records[recordIndex]);
        const outcome = execute(code, working, { counter, crashAfter, recordIndex });
        if (!outcome.dropped) batchOutput.push(outcome.record);
      }
    } catch (err) {
      if (err instanceof CrashError) throw err;
      // Roll back the whole batch: batchOutput is discarded, results/state
      // still reflect exactly the last committed batch.
      return {
        ok: false,
        error: {
          message: err.message,
          recordIndex: err.recordIndex ?? null,
          pc: err.pc ?? null,
          rolledBackBatch: { startIndex: index, endIndex: end - 1 },
        },
        committedThrough,
        batches,
        records: results,
      };
    }
    results.push(...batchOutput);
    batches.push({
      batch: batches.length,
      startIndex: index,
      endIndex: end - 1,
      emitted: batchOutput.length,
      committed: true,
    });
    committedThrough = end - 1;
    persist('committed');
    index = end;
  }
  return { ok: true, records: results, batches, committedThrough };
}
