import { decodeVlq, encodeVlq } from './vlq.js';
import type { ParsedSourceMap, Segment, SourceMapData } from './types.js';

export const UNMAPPED: Omit<Segment, 'genCol'> = { src: -1, srcLine: -1, srcCol: -1, name: -1 };

export function parseMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  for (const rawLine of mappings.split(';')) {
    const segs: Segment[] = [];
    let genCol = 0;
    if (rawLine.length > 0) {
      for (const part of rawLine.split(',')) {
        const pos = { i: 0 };
        genCol += decodeVlq(part, pos);
        if (pos.i >= part.length) {
          segs.push({ genCol, ...UNMAPPED });
          continue;
        }
        src += decodeVlq(part, pos);
        srcLine += decodeVlq(part, pos);
        srcCol += decodeVlq(part, pos);
        let nameIdx = -1;
        if (pos.i < part.length) {
          name += decodeVlq(part, pos);
          nameIdx = name;
        }
        segs.push({ genCol, src, srcLine, srcCol, name: nameIdx });
      }
    }
    lines.push(segs);
  }
  return lines;
}

export function serializeMappings(lines: Segment[][]): string {
  const outLines: string[] = [];
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  for (const segs of lines) {
    let genCol = 0;
    const parts: string[] = [];
    for (const s of segs) {
      let part = encodeVlq(s.genCol - genCol);
      genCol = s.genCol;
      if (s.src !== -1) {
        part += encodeVlq(s.src - src);
        src = s.src;
        part += encodeVlq(s.srcLine - srcLine);
        srcLine = s.srcLine;
        part += encodeVlq(s.srcCol - srcCol);
        srcCol = s.srcCol;
        if (s.name !== -1) {
          part += encodeVlq(s.name - name);
          name = s.name;
        }
      }
      parts.push(part);
    }
    outLines.push(parts.join(','));
  }
  return outLines.join(';');
}

export function parseSourceMap(map: SourceMapData): ParsedSourceMap {
  return { sources: map.sources, names: map.names, lines: parseMappings(map.mappings) };
}
