import type { Range } from "./types.js";

/**
 * One contiguous piece of the output text.
 * `src` is the half-open range in the source text it was copied from, or
 * `null` when the piece was inserted by the template and has no source.
 */
export interface Segment {
  out: Range;
  src: Range | null;
}

function rangesTouch(aOut: Range, aSrc: Range | null, b: Segment): boolean {
  if (aOut.end !== b.out.start) return false;
  if (aSrc === null || b.src === null) return aSrc === null && b.src === null;
  return aSrc.end === b.src.start;
}

/** Drops empty segments and merges adjacent ones that form one run. */
export function normalizeSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.out.end <= seg.out.start) continue;
    const last = out.length > 0 ? out[out.length - 1] : undefined;
    if (last !== undefined && rangesTouch(last.out, last.src, seg)) {
      last.out = { start: last.out.start, end: seg.out.end };
      last.src =
        last.src === null
          ? null
          : { start: last.src.start, end: (seg.src as Range).end };
    } else {
      out.push({
        out: { start: seg.out.start, end: seg.out.end },
        src: seg.src === null ? null : { start: seg.src.start, end: seg.src.end },
      });
    }
  }
  return out;
}

/**
 * A mapping between a source text and the output of one replacement round.
 * Segments are sorted, non-overlapping, and cover [0, outputLength).
 */
export class SourceMap {
  readonly segments: ReadonlyArray<Segment>;
  readonly sourceLength: number;
  readonly outputLength: number;

  constructor(segments: Segment[], sourceLength: number, outputLength: number) {
    this.segments = normalizeSegments(segments);
    this.sourceLength = sourceLength;
    this.outputLength = outputLength;
  }

  static identity(length: number): SourceMap {
    return new SourceMap(
      [{ out: { start: 0, end: length }, src: { start: 0, end: length } }],
      length,
      length,
    );
  }

  private segmentIndexAt(outPos: number): number {
    let lo = 0;
    let hi = this.segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = this.segments[mid];
      if (outPos < seg.out.start) hi = mid - 1;
      else if (outPos >= seg.out.end) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  /**
   * Forward query: the source position an output position was copied from,
   * or null when the output position is inserted content (or out of bounds).
   */
  sourcePositionAt(outPos: number): number | null {
    const idx = this.segmentIndexAt(outPos);
    if (idx < 0) return null;
    const seg = this.segments[idx];
    if (seg.src === null) return null;
    return seg.src.start + (outPos - seg.out.start);
  }

  /**
   * Inverse query: every output range derived from the given source
   * position. Because captures can be copied more than once, one source
   * position may map to several output ranges, so all of them are returned.
   */
  outputRangesForSource(srcPos: number): Range[] {
    const ranges: Range[] = [];
    for (const seg of this.segments) {
      if (seg.src === null) continue;
      if (srcPos >= seg.src.start && srcPos < seg.src.end) {
        ranges.push({ start: seg.out.start, end: seg.out.end });
      }
    }
    return ranges;
  }

  /**
   * Composes this map (A -> B) with the next round's map (B -> C) into a
   * map from A directly to C. Inserted content stays source-less.
   */
  compose(next: SourceMap): SourceMap {
    if (next.sourceLength !== this.outputLength) {
      throw new Error(
        `Cannot compose: next source length ${next.sourceLength} ` +
          `!= this output length ${this.outputLength}`,
      );
    }
    const segments: Segment[] = [];
    for (const s of next.segments) {
      if (s.src === null) {
        segments.push({ out: s.out, src: null });
        continue;
      }
      let b = s.src.start;
      while (b < s.src.end) {
        const idx = this.segmentIndexAt(b);
        if (idx < 0) {
          throw new Error(`Compose: no segment covers position ${b}`);
        }
        const seg = this.segments[idx];
        const overlapEnd = Math.min(seg.out.end, s.src.end);
        const len = overlapEnd - b;
        const outStart = s.out.start + (b - s.src.start);
        segments.push({
          out: { start: outStart, end: outStart + len },
          src:
            seg.src === null
              ? null
              : {
                  start: seg.src.start + (b - seg.out.start),
                  end: seg.src.start + (overlapEnd - seg.out.start),
                },
        });
        b = overlapEnd;
      }
    }
    return new SourceMap(segments, this.sourceLength, next.outputLength);
  }
}
