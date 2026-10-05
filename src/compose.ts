import { parseSourceMap, serializeMappings, UNMAPPED } from './mappings.js';
import { greatestLowerBound } from './query.js';
import type { ParsedSourceMap, Segment, SourceMapData } from './types.js';

function lookupSegment(map: ParsedSourceMap, line: number, col: number): Segment | null {
  if (line < 0 || line >= map.lines.length) return null;
  return greatestLowerBound(map.lines[line], col);
}

export function composeSourceMaps(outer: SourceMapData, inner: SourceMapData): SourceMapData {
  const o = parseSourceMap(outer);
  const i = parseSourceMap(inner);
  const sources: string[] = [];
  const names: string[] = [];
  const sourceIndex = new Map<string, number>();
  const nameIndex = new Map<string, number>();
  const useSource = (value: string): number => {
    let idx = sourceIndex.get(value);
    if (idx === undefined) {
      idx = sources.length;
      sources.push(value);
      sourceIndex.set(value, idx);
    }
    return idx;
  };
  const useName = (value: string): number => {
    let idx = nameIndex.get(value);
    if (idx === undefined) {
      idx = names.length;
      names.push(value);
      nameIndex.set(value, idx);
    }
    return idx;
  };
  const lines: Segment[][] = o.lines.map((oLine) => {
    const outLine: Segment[] = [];
    for (const s of oLine) {
      const t = s.src === -1 ? null : lookupSegment(i, s.srcLine, s.srcCol);
      if (!t || t.src === -1) {
        outLine.push({ genCol: s.genCol, ...UNMAPPED });
        continue;
      }
      const nameValue =
        t.name !== -1 ? i.names[t.name] : s.name !== -1 ? o.names[s.name] : undefined;
      outLine.push({
        genCol: s.genCol,
        src: useSource(i.sources[t.src]),
        srcLine: t.srcLine,
        srcCol: t.srcCol,
        name: nameValue === undefined ? -1 : useName(nameValue),
      });
    }
    return outLine;
  });
  return { version: 3, sources, names, mappings: serializeMappings(lines) };
}
