/**
 * Pattern syntax: segments joined by "/".
 *   - literal segment: one or more lowercase letters [a-z]+
 *   - "*":  matches exactly one segment
 *   - "**": whole-segment double star, matches zero or more segments
 * Empty segments (leading/trailing/doubled "/") and any other use of "*"
 * are rejected.
 */

export const MAX_SEGMENTS = 12;
export const MAX_EXCLUDES = 10;

export type Segment =
  | { kind: "lit"; value: string }
  | { kind: "star" }
  | { kind: "dstar" };

export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternError";
  }
}

const LITERAL_RE = /^[a-z]+$/;

export function parsePattern(source: string): Segment[] {
  if (source.length === 0) {
    throw new PatternError("pattern is empty (empty segment)");
  }
  const raw = source.split("/");
  if (raw.length > MAX_SEGMENTS) {
    throw new PatternError(
      `pattern has ${raw.length} segments, max is ${MAX_SEGMENTS}`,
    );
  }
  return raw.map((part) => {
    if (part.length === 0) {
      throw new PatternError(`empty segment in pattern "${source}"`);
    }
    if (part === "*") return { kind: "star" };
    if (part === "**") return { kind: "dstar" };
    if (part.includes("*")) {
      throw new PatternError(
        `invalid wildcard segment "${part}" (only "*" and "**" whole segments are allowed)`,
      );
    }
    if (!LITERAL_RE.test(part)) {
      throw new PatternError(
        `invalid literal segment "${part}" (only [a-z]+ is allowed)`,
      );
    }
    return { kind: "lit", value: part };
  });
}

export function formatPattern(segments: Segment[]): string {
  return segments
    .map((seg) => (seg.kind === "lit" ? seg.value : seg.kind === "star" ? "*" : "**"))
    .join("/");
}

/** All literal values appearing in the given patterns. */
export function collectLiterals(patterns: Segment[][]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const seg of pattern) {
      if (seg.kind === "lit") out.add(seg.value);
    }
  }
  return [...out];
}
