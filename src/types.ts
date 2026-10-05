/** A half-open range of UTF-16 code unit offsets: [start, end). */
export interface Range {
  start: number;
  end: number;
}

/**
 * One non-overlapping match in the source text.
 *
 * `captures[i]` is the source range referenced by `$i` in a replacement
 * template. `captures[0]` denotes the whole match; when omitted it defaults
 * to `{ start, end }`. An `undefined` entry means the group did not
 * participate; referencing it from a template is rejected.
 */
export interface MatchInfo {
  start: number;
  end: number;
  captures?: ReadonlyArray<Range | undefined>;
}
