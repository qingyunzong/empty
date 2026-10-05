import { decodeVlq, encodeVlq } from './vlq.js';
import type { Mapping, Segment, SourceMapData } from './types.js';

export function compareSegments(a: Segment, b: Segment): number {
  return a.genLine - b.genLine || a.genCol - b.genCol;
}

/** Decode a source-map v3 `mappings` string into sparse segments. */
export function parseMappings(
  mappings: string,
  sources: readonly string[],
  names: readonly string[],
): SourceMapData {
  const segments: Segment[] = [];
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIndex = 0;
  const lines = mappings.split(';');
  for (let genLine = 0; genLine < lines.length; genLine++) {
    const lineText = lines[genLine] as string;
    if (lineText === '') continue;
    let genCol = 0;
    for (const part of lineText.split(',')) {
      let cursor = decodeVlq(part, 0);
      genCol += cursor.value;
      const segment: Segment = { genLine, genCol };
      if (cursor.next < part.length) {
        cursor = decodeVlq(part, cursor.next);
        srcIndex += cursor.value;
        cursor = decodeVlq(part, cursor.next);
        srcLine += cursor.value;
        cursor = decodeVlq(part, cursor.next);
        srcCol += cursor.value;
        segment.srcIndex = srcIndex;
        segment.srcLine = srcLine;
        segment.srcCol = srcCol;
        if (cursor.next < part.length) {
          cursor = decodeVlq(part, cursor.next);
          nameIndex += cursor.value;
          segment.nameIndex = nameIndex;
        }
      }
      segments.push(segment);
    }
  }
  return { version: 3, sources: [...sources], names: [...names], segments };
}

/** Encode sparse segments as a compressed source-map v3 `mappings` string. */
export function serializeMappings(map: SourceMapData): string {
  const sorted = [...map.segments].sort(compareSegments);
  const lines: string[] = [];
  let currentLine = 0;
  let genCol = 0;
  let srcIndex = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIndex = 0;
  let parts: string[] = [];
  for (const seg of sorted) {
    while (currentLine < seg.genLine) {
      lines.push(parts.join(','));
      parts = [];
      currentLine++;
      genCol = 0;
    }
    let out = encodeVlq(seg.genCol - genCol);
    genCol = seg.genCol;
    if (seg.srcIndex !== undefined) {
      out += encodeVlq(seg.srcIndex - srcIndex);
      srcIndex = seg.srcIndex;
      out += encodeVlq((seg.srcLine as number) - srcLine);
      srcLine = seg.srcLine as number;
      out += encodeVlq((seg.srcCol as number) - srcCol);
      srcCol = seg.srcCol as number;
      if (seg.nameIndex !== undefined) {
        out += encodeVlq(seg.nameIndex - nameIndex);
        nameIndex = seg.nameIndex;
      }
    }
    parts.push(out);
  }
  lines.push(parts.join(','));
  return lines.join(';');
}

/** A source map with segments grouped per generated line for fast lookup. */
export interface IndexedMap {
  map: SourceMapData;
  /** `lines[l]` holds the segments of generated line `l`, sorted by column. */
  lines: Segment[][];
}

export function indexMap(map: SourceMapData): IndexedMap {
  const sorted = [...map.segments].sort(compareSegments);
  const lines: Segment[][] = [];
  for (const seg of sorted) {
    while (lines.length <= seg.genLine) lines.push([]);
    (lines[seg.genLine] as Segment[]).push(seg);
  }
  return { map, lines };
}

/**
 * Query the original position for a generated (line, column).
 *
 * Semantics:
 * - Only segments on the same generated line are considered; positions are
 *   never borrowed from other lines.
 * - The nearest segment at or to the left of `column` wins (greatest lower
 *   bound). If there is none, the position is unmapped.
 * - An unmapped segment stays unmapped: the lookup does not fall through to
 *   earlier mapped segments on the same line.
 * - The reported name is the matched segment's own name; empty names count
 *   as no name.
 */
export function originalPositionFor(
  indexed: IndexedMap,
  line: number,
  column: number,
): Mapping | null {
  const segs = indexed.lines[line];
  if (segs === undefined || segs.length === 0) return null;
  let lo = 0;
  let hi = segs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((segs[mid] as Segment).genCol <= column) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  const seg = segs[found] as Segment;
  if (seg.srcIndex === undefined) return null;
  const rawName = seg.nameIndex === undefined ? undefined : indexed.map.names[seg.nameIndex];
  return {
    source: indexed.map.sources[seg.srcIndex] as string,
    sourceIndex: seg.srcIndex,
    line: seg.srcLine as number,
    column: seg.srcCol as number,
    name: rawName === '' ? undefined : rawName,
  };
}
