import type { OriginalPosition, ParsedSourceMap, Segment } from './types.js';

export function greatestLowerBound(segs: Segment[], col: number): Segment | null {
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].genCol <= col) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found === -1 ? null : segs[found];
}

export function originalPositionFor(
  map: ParsedSourceMap,
  line: number,
  col: number,
): OriginalPosition | null {
  if (line < 0 || line >= map.lines.length) return null;
  const seg = greatestLowerBound(map.lines[line], col);
  if (!seg || seg.src === -1) return null;
  return {
    source: map.sources[seg.src],
    line: seg.srcLine,
    column: seg.srcCol,
    name: seg.name === -1 ? undefined : map.names[seg.name],
  };
}
