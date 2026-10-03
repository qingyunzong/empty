// Report building: safety verdict, enumeration certificate and state hash.

import { createHash } from 'node:crypto';

export function buildReport(pool, stats) {
  const certificate = stats.safe
    ? {
        schedules: stats.scheduleCount.toString(),
        states: stats.statesVisited,
        transitions: stats.transitions,
        invariantChecks: stats.invariantChecks,
        invariant: 'used + frozen <= limit',
      }
    : null;
  const stateHash = createHash('sha256')
    .update(
      JSON.stringify({
        pool,
        safe: stats.safe,
        violation: stats.violation,
        schedules: stats.scheduleCount.toString(),
        states: stats.statesVisited,
        transitions: stats.transitions,
      }),
    )
    .digest('hex');
  return {
    seed: pool.seed,
    pool,
    safe: stats.safe,
    violation: stats.violation,
    certificate,
    stateHash,
  };
}
