/** Half-open interval [start, end) measured in UTF-16 code units. */
export interface Range {
  start: number;
  end: number;
}

/**
 * A single non-overlapping match inside the input text, together with the
 * intervals of its capture groups. `start === end` denotes a zero-length
 * match. A capture is `null` when the group did not participate.
 */
export interface CaptureMatch {
  start: number;
  end: number;
  captures: (Range | null)[];
}
