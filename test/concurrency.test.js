import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

test('acceptance 1: 6 threads, verifier agrees with exponential reference enumeration', async () => {
  const THREADS = 6;
  const PER_THREAD = 25;
  const jobs = Array.from({ length: THREADS }, (_, w) =>
    Array.from({ length: PER_THREAD }, (_, i) => `w${w}-s${i}`),
  );
  const results = await Promise.all(
    jobs.map(
      (seeds) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(new URL('../src/refCheckWorker.js', import.meta.url), {
            workerData: { seeds },
          });
          worker.once('message', resolve);
          worker.once('error', reject);
        }),
    ),
  );
  let total = 0;
  const tally = { LINEARIZABLE: 0, VIOLATION: 0, UNKNOWN: 0 };
  for (const r of results) {
    assert.deepEqual(r.mismatches, [], 'verifier must match reference enumeration');
    total += r.total;
    for (const k of Object.keys(tally)) tally[k] += r.counts[k];
  }
  assert.equal(total, THREADS * PER_THREAD);
  assert.ok(tally.LINEARIZABLE > 0, 'expected some linearizable histories');
  assert.ok(tally.VIOLATION > 0, 'expected some violating histories');
  assert.equal(tally.UNKNOWN, 0, 'complete histories must not be UNKNOWN');
});
