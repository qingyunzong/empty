import { deepEqual, ok } from 'node:assert/strict';
import { composeSourceMaps } from '../src/compose.js';
import { parseSourceMap, serializeMappings } from '../src/mappings.js';
import { originalPositionFor } from '../src/query.js';
import type { ParsedSourceMap, Segment, SourceMapData } from '../src/types.js';

export interface RefPos {
  source: string;
  line: number;
  column: number;
  name: string | undefined;
}

export function refQuery(map: ParsedSourceMap, line: number, col: number): RefPos | null {
  if (line < 0) return null;
  const segs = map.lines[line];
  if (!segs) return null;
  let best: Segment | null = null;
  for (const s of segs) {
    if (s.genCol <= col && (best === null || s.genCol > best.genCol)) best = s;
  }
  if (!best || best.src === -1) return null;
  return {
    source: map.sources[best.src],
    line: best.srcLine,
    column: best.srcCol,
    name: best.name === -1 ? undefined : map.names[best.name],
  };
}

export function refCompose(
  outer: ParsedSourceMap,
  inner: ParsedSourceMap,
  line: number,
  col: number,
): RefPos | null {
  const mid = refQuery(outer, line, col);
  if (!mid) return null;
  const orig = refQuery(inner, mid.line, mid.column);
  if (!orig) return null;
  return {
    source: orig.source,
    line: orig.line,
    column: orig.column,
    name: orig.name !== undefined ? orig.name : mid.name,
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomMap(rnd: () => number, id: string): SourceMapData {
  const sources = [`${id}0.ts`, `${id}1.ts`, `${id}2.ts`].slice(0, 1 + Math.floor(rnd() * 3));
  const namePool = [`${id}Alpha`, `${id}Beta`, `${id}Gamma`];
  const names: string[] = [];
  const lines: Segment[][] = [];
  const lineCount = Math.floor(rnd() * 9);
  for (let l = 0; l < lineCount; l++) {
    const segs: Segment[] = [];
    const segCount = Math.floor(rnd() * 6);
    let col = Math.floor(rnd() * 3);
    for (let s = 0; s < segCount; s++) {
      if (s > 0) col += 1 + Math.floor(rnd() * 4);
      if (rnd() < 0.15) {
        segs.push({ genCol: col, src: -1, srcLine: -1, srcCol: -1, name: -1 });
        continue;
      }
      let name = -1;
      if (rnd() < 0.4) {
        const value = namePool[Math.floor(rnd() * namePool.length)];
        let idx = names.indexOf(value);
        if (idx === -1) {
          idx = names.length;
          names.push(value);
        }
        name = idx;
      }
      segs.push({
        genCol: col,
        src: Math.floor(rnd() * sources.length),
        srcLine: Math.floor(rnd() * 7),
        srcCol: Math.floor(rnd() * 21),
        name,
      });
    }
    lines.push(segs);
  }
  return { version: 3, sources, names, mappings: serializeMappings(lines) };
}

export function assertComposedEqualsReference(outer: SourceMapData, inner: SourceMapData): void {
  const composed = composeSourceMaps(outer, inner);
  const cp = parseSourceMap(composed);
  const op = parseSourceMap(outer);
  const ip = parseSourceMap(inner);
  for (const segs of cp.lines) {
    let prev = -1;
    for (const s of segs) {
      ok(s.genCol > prev, 'generated columns must be strictly increasing');
      prev = s.genCol;
      if (s.src !== -1) {
        ok(s.src >= 0 && s.src < composed.sources.length, 'source index in bounds');
        if (s.name !== -1) ok(s.name >= 0 && s.name < composed.names.length, 'name index in bounds');
      }
    }
  }
  const lineLimit = op.lines.length + 2;
  for (let line = 0; line < lineLimit; line++) {
    const segs = op.lines[line] ?? [];
    const maxCol = segs.reduce((m, s) => Math.max(m, s.genCol), 0) + 3;
    for (let col = 0; col <= maxCol; col++) {
      const viaMap = originalPositionFor(cp, line, col);
      const viaRef = refCompose(op, ip, line, col);
      deepEqual(viaMap, viaRef, `mismatch at generated ${line}:${col}`);
    }
  }
}
