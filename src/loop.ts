import { toTime, type TimeInput } from "./track.js";

export interface LoopRegion {
  start: TimeInput;
  /** Exclusive end for "loop", inclusive turning point for "reverse". */
  end: TimeInput;
}

function regionOf(region: LoopRegion): { start: bigint; length: bigint } {
  const start = toTime(region.start);
  const end = toTime(region.end);
  if (end <= start) throw new RangeError("loop end must be greater than loop start");
  return { start, length: end - start };
}

/** Floor modulo, exact for integers of any sign. */
function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/**
 * Forward loop over [start, end): time wraps around and the interval end
 * maps back to the start, so sampling is continuous across the boundary.
 */
export function loopTime(t: TimeInput, region: LoopRegion): bigint {
  const { start, length } = regionOf(region);
  return start + mod(toTime(t) - start, length);
}

/**
 * Reverse (ping-pong) loop, defined separately from the forward loop:
 * time runs start -> end -> start with period 2 * (end - start), touching
 * both endpoints exactly once per turn.
 */
export function reverseLoopTime(t: TimeInput, region: LoopRegion): bigint {
  const { start, length } = regionOf(region);
  const m = mod(toTime(t) - start, 2n * length);
  return m <= length ? start + m : start + (2n * length - m);
}
