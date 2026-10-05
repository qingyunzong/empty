import type { Sample, Value } from "./state-sequence.js";

/**
 * Per-tick reference interpreter. It evaluates every tick independently
 * straight from the raw sample list (duplicated ticks included), applying
 * the same rules as the store:
 *  - among samples with time <= t, the latest tick wins;
 *  - ties at that tick are broken by the higher version;
 *  - the winner holds only while t < time + ttl (no TTL: holds forever);
 *  - an expired hole stays a hole regardless of what happens later.
 */
export function interpretTick(samples: Iterable<Sample>, t: number): Value | null {
  let best: Sample | null = null;
  for (const s of samples) {
    if (s.time > t) continue;
    if (
      best === null ||
      s.time > best.time ||
      (s.time === best.time && s.version > best.version)
    ) {
      best = s;
    }
  }
  if (best === null) return null;
  if (best.ttl !== undefined && t >= best.time + best.ttl) return null;
  return best.value;
}

/** Value at every tick of the half-open range [start, end). */
export function interpretRange(
  samples: Iterable<Sample>,
  start: number,
  end: number,
): (Value | null)[] {
  const snapshot = [...samples];
  const out: (Value | null)[] = [];
  for (let t = start; t < end; t++) {
    out.push(interpretTick(snapshot, t));
  }
  return out;
}
