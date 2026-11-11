/**
 * A subtitle cue to be laid out on integer lines.
 *
 * - Time interval is half-open: [start, end).
 * - Horizontal pixel interval is half-open: [x0, x1).
 * - `lineHeight` is a positive integer: the cue occupies the
 *   `lineHeight` consecutive lines [line, line + lineHeight).
 * - `preferredLine` is the smallest line the cue wants to start on.
 * - `id` is stable across corrections.
 */
export interface Subtitle {
  readonly id: string;
  /** Start time, inclusive. */
  readonly start: number;
  /** End time, exclusive. Must be greater than `start`. */
  readonly end: number;
  /** Left edge in pixels, inclusive. */
  readonly x0: number;
  /** Right edge in pixels, exclusive. Must be greater than `x0`. */
  readonly x1: number;
  /** Positive integer number of lines this cue occupies. */
  readonly lineHeight: number;
  /** Non-negative integer: preferred (minimum) starting line. */
  readonly preferredLine: number;
}

/** A subtitle together with its assigned starting line. */
export interface PlacedSubtitle {
  readonly subtitle: Subtitle;
  readonly line: number;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Throws TypeError/RangeError when a subtitle violates its invariants. */
export function validateSubtitle(subtitle: Subtitle): Subtitle {
  if (typeof subtitle.id !== "string" || subtitle.id.length === 0) {
    throw new TypeError("subtitle id must be a non-empty string");
  }
  if (!Number.isFinite(subtitle.start) || !Number.isFinite(subtitle.end)) {
    throw new RangeError(`subtitle ${subtitle.id}: start/end must be finite`);
  }
  if (!(subtitle.start < subtitle.end)) {
    throw new RangeError(
      `subtitle ${subtitle.id}: start must be < end (half-open interval)`,
    );
  }
  if (!Number.isFinite(subtitle.x0) || !Number.isFinite(subtitle.x1)) {
    throw new RangeError(`subtitle ${subtitle.id}: x0/x1 must be finite`);
  }
  if (!(subtitle.x0 < subtitle.x1)) {
    throw new RangeError(
      `subtitle ${subtitle.id}: x0 must be < x1 (half-open interval)`,
    );
  }
  if (!Number.isInteger(subtitle.lineHeight) || subtitle.lineHeight <= 0) {
    throw new RangeError(
      `subtitle ${subtitle.id}: lineHeight must be a positive integer`,
    );
  }
  if (!isNonNegativeInteger(subtitle.preferredLine)) {
    throw new RangeError(
      `subtitle ${subtitle.id}: preferredLine must be a non-negative integer`,
    );
  }
  return subtitle;
}

/** Structural equality on every layout-relevant field. */
export function subtitleEquals(a: Subtitle, b: Subtitle): boolean {
  return (
    a.id === b.id &&
    a.start === b.start &&
    a.end === b.end &&
    a.x0 === b.x0 &&
    a.x1 === b.x1 &&
    a.lineHeight === b.lineHeight &&
    a.preferredLine === b.preferredLine
  );
}
