import type { CaptureMatch, Range } from './types';

/**
 * Finds all non-overlapping matches of `pattern` in `text`, including the
 * interval of every capture group (via the `d` flag, added if missing).
 *
 * After a zero-length match the scan position is advanced by one full code
 * point (two code units for astral characters) so the iteration always
 * terminates and never splits a surrogate pair.
 */
export function findMatches(text: string, pattern: RegExp): CaptureMatch[] {
  let flags = pattern.flags.replace('y', '');
  if (!flags.includes('g')) flags += 'g';
  if (!flags.includes('d')) flags += 'd';
  const re = new RegExp(pattern.source, flags);
  const matches: CaptureMatch[] = [];
  for (;;) {
    const m = re.exec(text);
    if (m === null) break;
    const start = m.index;
    const end = start + m[0].length;
    const indices = (m as RegExpExecArray & { indices?: ([number, number] | undefined)[] })
      .indices;
    const captures: (Range | null)[] = [];
    for (let g = 1; g < m.length; g += 1) {
      const span = indices ? indices[g] : undefined;
      captures.push(span === undefined ? null : { start: span[0], end: span[1] });
    }
    matches.push({ start, end, captures });
    if (end === start) {
      const cp = text.codePointAt(end);
      if (cp === undefined) break; // zero-length match at end of text
      re.lastIndex = end + (cp > 0xffff ? 2 : 1);
    }
  }
  return matches;
}
