/** A parsed pattern segment. */
export type Seg =
  | { kind: "lit"; value: string }
  | { kind: "star" }      // matches exactly one segment
  | { kind: "starstar" }; // matches zero or more whole segments

export const MAX_PATTERN_SEGMENTS = 12;
export const MAX_EXCLUDES = 10;

export class PatternError extends Error {}

/**
 * Parse a pattern like "a/*&#47;**" into segments.
 * Rules: segments are separated by '/', every segment is either a literal of
 * lowercase letters [a-z]+, a single '*', or a whole '**'. Empty segments
 * (leading/trailing/doubled '/') and any other shape are rejected.
 */
export function parsePattern(src: string): Seg[] {
  if (src.length === 0) {
    throw new PatternError("pattern is empty");
  }
  const parts = src.split("/");
  const segs: Seg[] = parts.map((p) => {
    if (p === "") {
      throw new PatternError(`empty segment in pattern "${src}"`);
    }
    if (p === "*") return { kind: "star" };
    if (p === "**") return { kind: "starstar" };
    if (!/^[a-z]+$/.test(p)) {
      throw new PatternError(
        `invalid segment "${p}" in pattern "${src}" (want [a-z]+, "*" or "**")`
      );
    }
    return { kind: "lit", value: p };
  });
  if (segs.length > MAX_PATTERN_SEGMENTS) {
    throw new PatternError(
      `pattern "${src}" has ${segs.length} segments (max ${MAX_PATTERN_SEGMENTS})`
    );
  }
  return segs;
}

export function patternToString(segs: Seg[]): string {
  return segs
    .map((s) => (s.kind === "lit" ? s.value : s.kind === "star" ? "*" : "**"))
    .join("/");
}
