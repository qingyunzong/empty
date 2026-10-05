import type { MatchInfo, Range } from "./types.js";

/**
 * Finds all matches of `pattern` in `source`, returning them as
 * non-overlapping MatchInfo entries with capture ranges (via the `d` flag).
 *
 * After a zero-length match the scan advances by one full code point (not
 * one UTF-16 code unit), so a supplementary-plane character is never split
 * and the loop cannot get stuck.
 */
export function findMatches(source: string, pattern: RegExp): MatchInfo[] {
  const flags = new Set(pattern.flags.split(""));
  flags.add("g");
  flags.add("u");
  flags.add("d");
  flags.delete("y");
  const re = new RegExp(pattern.source, [...flags].join(""));

  const matches: MatchInfo[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const indices = (m as unknown as { indices: Array<[number, number] | undefined> })
      .indices;
    const captures: Array<Range | undefined> = indices.map((pair) =>
      pair === undefined ? undefined : { start: pair[0], end: pair[1] },
    );
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      captures,
    });
    if (m[0].length === 0) {
      const cp = source.codePointAt(m.index);
      re.lastIndex = m.index + (cp !== undefined && cp > 0xffff ? 2 : 1);
    }
  }
  return matches;
}
