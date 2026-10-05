import { indexMap, originalPositionFor } from './mappings.js';
import type { Segment, SourceMapData } from './types.js';

function nonEmpty(name: string | undefined): string | undefined {
  return name === '' ? undefined : name;
}

/**
 * Compose two sparse source maps into one.
 *
 * `outer` maps generated -> intermediate, `inner` maps intermediate ->
 * original; the result maps generated -> original.
 *
 * For every mapped outer segment the inner map is queried at the segment's
 * intermediate position with the same-line nearest-left rule. If the inner
 * lookup is unmapped (no segment on that line, or the nearest-left segment
 * has no source), the composed segment stays unmapped. The composed name is
 * the last non-empty name along the composition chain: the inner (original)
 * name when present, otherwise the outer name.
 */
export function compose(outer: SourceMapData, inner: SourceMapData): SourceMapData {
  const innerIndexed = indexMap(inner);
  const sources: string[] = [];
  const sourceIds = new Map<number, number>();
  const names: string[] = [];
  const nameIds = new Map<string, number>();
  const segments: Segment[] = [];

  const internSource = (innerIndex: number): number => {
    let id = sourceIds.get(innerIndex);
    if (id === undefined) {
      id = sources.length;
      sources.push(inner.sources[innerIndex] as string);
      sourceIds.set(innerIndex, id);
    }
    return id;
  };
  const internName = (name: string): number => {
    let id = nameIds.get(name);
    if (id === undefined) {
      id = names.length;
      names.push(name);
      nameIds.set(name, id);
    }
    return id;
  };

  for (const seg of outer.segments) {
    const out: Segment = { genLine: seg.genLine, genCol: seg.genCol };
    if (seg.srcIndex !== undefined) {
      const hit = originalPositionFor(innerIndexed, seg.srcLine as number, seg.srcCol as number);
      if (hit !== null) {
        out.srcIndex = internSource(hit.sourceIndex);
        out.srcLine = hit.line;
        out.srcCol = hit.column;
        const outerName =
          seg.nameIndex === undefined ? undefined : nonEmpty(outer.names[seg.nameIndex]);
        const name = hit.name ?? outerName;
        if (name !== undefined) out.nameIndex = internName(name);
      }
    }
    segments.push(out);
  }
  return { version: 3, sources, names, segments };
}
