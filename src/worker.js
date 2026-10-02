import { parentPort, workerData } from 'node:worker_threads';
import { randomHistory } from './random-history.js';
import { verify } from './verify.js';
import { referenceVerdict } from './reference.js';

// Each worker checks `count` random histories with both the memoized verifier
// and the exponential reference enumerator, and reports any disagreement.
const { baseSeed, count } = workerData;
const tally = { LINEARIZABLE: 0, VIOLATION: 0, UNKNOWN: 0 };
const mismatches = [];
for (let i = 0; i < count; i++) {
  const seed = baseSeed + i;
  const history = randomHistory(seed);
  const fast = verify(history).verdict;
  const ref = referenceVerdict(history);
  tally[fast] += 1;
  if (fast !== ref) mismatches.push({ seed, fast, ref });
}
parentPort.postMessage({ checked: count, mismatches, tally });
