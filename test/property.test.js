import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { checkSlice } from '../testkit/perm-core.mjs';

/**
 * Property test: for <= 3 events, enumerate every permutation of the
 * insert / correct / delete operation order and check the store against a
 * naive reference model (plain version array, "sorted by txAt + snapshot
 * filter"), including E_DUP / E_NOTFOUND error parity.
 *
 * The 3-event case (9! = 362880 orders) is fanned out to worker threads;
 * each worker checks a slice index % numWorkers === workerId.
 */

function runSlice(eventCount, workerId, numWorkers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../testkit/perm-worker.mjs', import.meta.url), {
      workerData: { eventCount, workerId, numWorkers },
    });
    worker.once('message', ({ checked }) => resolve(checked));
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`worker ${workerId} exited with code ${code}`));
    });
  });
}

test('permutation enumeration: 1 event (insert/correct/delete), 6 orders', () => {
  assert.equal(checkSlice(1, 0, 1), 6);
});

test('permutation enumeration: 2 events, 720 orders', () => {
  assert.equal(checkSlice(2, 0, 1), 720);
});

test('permutation enumeration: 3 events, 362880 orders', { timeout: 300000 }, async () => {
  const numWorkers = Math.max(2, Math.min(12, os.availableParallelism() - 2));
  const parts = await Promise.all(
    Array.from({ length: numWorkers }, (_, workerId) => runSlice(3, workerId, numWorkers)),
  );
  assert.equal(parts.reduce((a, b) => a + b, 0), 362880);
});
