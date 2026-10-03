// Worker: compares the memoized verifier against the exponential reference
// enumerator on random histories. Run by test/concurrency.test.js.
import { workerData, parentPort, isMainThread } from 'node:worker_threads';
import { randomHistory } from './historyGen.js';
import { check, referenceLinearizable } from './verifier.js';

if (!isMainThread) {
  const mismatches = [];
  const counts = { LINEARIZABLE: 0, VIOLATION: 0, UNKNOWN: 0 };
  let total = 0;
  for (const seed of workerData.seeds) {
    const h = randomHistory(seed);
    const main = check(h).verdict;
    const ref = referenceLinearizable(h) ? 'LINEARIZABLE' : 'VIOLATION';
    counts[main] += 1;
    total += 1;
    if (main !== ref) mismatches.push({ seed, main, ref });
  }
  parentPort.postMessage({ mismatches, counts, total });
}
