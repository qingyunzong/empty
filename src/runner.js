import { canonical } from './canon.js';

export class DuplicateConflictError extends Error {
  constructor(clOrdId) {
    super(`duplicate clOrdId with different payload: ${clOrdId}`);
    this.name = 'DuplicateConflictError';
    this.code = 'DUP_CONFLICT';
    this.clOrdId = clOrdId;
  }
}

// Retransmission dedup + reordering.
// - Identical frames (same clOrdId, same full payload incl. seq/crc) collapse
//   to one, so retransmission never changes the audit root.
// - Same clOrdId with a different payload is a conflict (exit 4).
// - Surviving frames are processed in log order: seq ascending, arrival order
//   as tie-breaker. This is what makes cancel-vs-match races deterministic.
export function prepareFrames(frames) {
  const seen = new Map();
  const kept = [];
  frames.forEach((frame, arrival) => {
    const payload = canonical(frame);
    if (seen.has(frame.clOrdId)) {
      if (seen.get(frame.clOrdId) !== payload) throw new DuplicateConflictError(frame.clOrdId);
      return;
    }
    seen.set(frame.clOrdId, payload);
    kept.push({ frame, arrival });
  });
  kept.sort((a, b) => a.frame.seq - b.frame.seq || a.arrival - b.arrival);
  return kept.map((k) => k.frame);
}
