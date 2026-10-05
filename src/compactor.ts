/**
 * Compaction horizon: the highest LSN confirmed by EVERY live replica
 * (the minimum of the ack vector). Entries at or below the horizon are
 * safe to reclaim. With no live replicas nothing is confirmed, so the
 * horizon is 0 and the log is kept intact.
 */
export function compactionHorizon(ackVector: Iterable<number>): number {
  let min = Number.POSITIVE_INFINITY;
  for (const ack of ackVector) {
    if (ack < min) min = ack;
  }
  return min === Number.POSITIVE_INFINITY ? 0 : min;
}
