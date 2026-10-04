import type { AlertEvent } from "./types.js";
import { compareEvents } from "./types.js";

/**
 * Reference model ("fully sorted scan"): sort every event by (time, id),
 * then scan once keeping the first in-window event per key. Used to
 * cross-check the incremental store against a brute-force computation.
 */
export function displayBySortedScan(
  events: Iterable<AlertEvent>,
  start: number,
  end: number,
): Map<string, AlertEvent> {
  const sorted = [...events].sort(compareEvents);
  const out = new Map<string, AlertEvent>();
  for (const event of sorted) {
    if (event.time < start || event.time >= end) continue;
    if (!out.has(event.key)) out.set(event.key, event);
  }
  return out;
}
