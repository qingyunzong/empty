import type { Range } from './types';

/**
 * One copied run: output [outStart, outEnd) originates from input
 * [inStart, inEnd). Inserted (literal) output has no segment.
 */
export interface Segment {
  outStart: number;
  outEnd: number;
  inStart: number;
  inEnd: number;
}

function mergeSegments(segments: Segment[]): Segment[] {
  const sorted = [...segments].sort((a, b) => a.outStart - b.outStart);
  const merged: Segment[] = [];
  for (const seg of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.outEnd === seg.outStart && last.inEnd === seg.inStart) {
      last.outEnd = seg.outEnd;
      last.inEnd = seg.inEnd;
    } else {
      merged.push({ ...seg });
    }
  }
  return merged;
}

/**
 * Bidirectional mapping between an input text and the output of one
 * replacement round. Because captures can be copied several times, a single
 * input position may correspond to several output ranges.
 */
export class SourceMap {
  readonly inLength: number;
  readonly outLength: number;
  readonly segments: readonly Segment[];

  constructor(inLength: number, outLength: number, segments: Segment[]) {
    this.inLength = inLength;
    this.outLength = outLength;
    this.segments = mergeSegments(segments);
  }

  /** Maps an output position to its input position, or null if it was inserted. */
  forward(outPos: number): number | null {
    for (const seg of this.segments) {
      if (outPos < seg.outStart) return null;
      if (outPos < seg.outEnd) return seg.inStart + (outPos - seg.outStart);
    }
    return null;
  }

  /**
   * Maps an input position to every output range produced from it. Returns
   * one single-code-unit range per segment; duplicated captures therefore
   * yield multiple ranges, and unknown positions yield an empty list.
   */
  inverse(inPos: number): Range[] {
    const ranges: Range[] = [];
    for (const seg of this.segments) {
      if (inPos >= seg.inStart && inPos < seg.inEnd) {
        const offset = inPos - seg.inStart;
        ranges.push({ start: seg.outStart + offset, end: seg.outStart + offset + 1 });
      }
    }
    return ranges;
  }

  /**
   * Composes `first` (t0 -> t1) with `second` (t1 -> t2) into a map
   * t0 -> t2. Output that round two copied from text inserted by round one
   * stays unmapped.
   */
  static compose(first: SourceMap, second: SourceMap): SourceMap {
    const segments: Segment[] = [];
    let cursor = 0;
    for (const s2 of second.segments) {
      while (cursor < first.segments.length && first.segments[cursor].outEnd <= s2.inStart) {
        cursor += 1;
      }
      let k = cursor;
      while (k < first.segments.length && first.segments[k].outStart < s2.inEnd) {
        const s1 = first.segments[k];
        const ovStart = Math.max(s1.outStart, s2.inStart);
        const ovEnd = Math.min(s1.outEnd, s2.inEnd);
        if (ovStart < ovEnd) {
          segments.push({
            outStart: s2.outStart + (ovStart - s2.inStart),
            outEnd: s2.outStart + (ovEnd - s2.inStart),
            inStart: s1.inStart + (ovStart - s1.outStart),
            inEnd: s1.inStart + (ovEnd - s1.outStart),
          });
        }
        k += 1;
      }
    }
    return new SourceMap(first.inLength, second.outLength, segments);
  }
}
