import type { Mapping, Segment, SourceMapData } from '../src/index.js';

/** Deterministic PRNG so fuzz runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export interface RandomMapOptions {
  maxLines: number;
  maxSegmentsPerLine: number;
  maxColumn: number;
  sourceCount: number;
  nameCount: number;
  /** Probability that a segment is unmapped. */
  unmappedChance: number;
  /** Probability that a mapped segment carries a name. */
  nameChance: number;
  /** Probability that a name is the empty string. */
  emptyNameChance: number;
  /** Target lines/columns may point past the map's own generated extent. */
  targetLineSlack: number;
  targetColSlack: number;
}

/** Build a random sparse source map. */
export function randomMap(rng: () => number, opts: RandomMapOptions): SourceMapData {
  const sources: string[] = [];
  for (let i = 0; i < opts.sourceCount; i++) sources.push(`src-${i}.ts`);
  const names: string[] = [];
  for (let i = 0; i < opts.nameCount; i++) names.push(`name${i}`);
  const lineCount = randInt(rng, 0, opts.maxLines);
  const segments: Segment[] = [];
  for (let genLine = 0; genLine < lineCount; genLine++) {
    const segCount = randInt(rng, 0, opts.maxSegmentsPerLine);
    let genCol = 0;
    for (let s = 0; s < segCount; s++) {
      // Strictly increasing columns: duplicate segment starts are malformed.
      genCol += randInt(rng, s === 0 ? 0 : 1, Math.max(1, Math.floor(opts.maxColumn / Math.max(1, segCount))));
      const segment: Segment = { genLine, genCol };
      if (rng() >= opts.unmappedChance) {
        segment.srcIndex = randInt(rng, 0, opts.sourceCount - 1);
        segment.srcLine = randInt(rng, 0, lineCount + opts.targetLineSlack);
        segment.srcCol = randInt(rng, 0, opts.maxColumn + opts.targetColSlack);
        if (rng() < opts.nameChance) {
          if (rng() < opts.emptyNameChance) {
            if (!names.includes('')) names.push('');
            segment.nameIndex = names.indexOf('');
          } else {
            segment.nameIndex = randInt(rng, 0, opts.nameCount - 1);
          }
        }
      }
      segments.push(segment);
    }
  }
  return { version: 3, sources, names, segments };
}

function nonEmpty(name: string | undefined): string | undefined {
  return name === '' ? undefined : name;
}

/**
 * Reference query: naive per-column semantics implemented independently of
 * the library (plain linear scans, no index, no binary search).
 */
export function referenceQuery(map: SourceMapData, line: number, column: number): Mapping | null {
  let best: Segment | undefined;
  for (const seg of map.segments) {
    if (seg.genLine !== line) continue;
    if (seg.genCol <= column && (best === undefined || seg.genCol > best.genCol)) best = seg;
  }
  if (best === undefined || best.srcIndex === undefined) return null;
  return {
    source: map.sources[best.srcIndex] as string,
    sourceIndex: best.srcIndex,
    line: best.srcLine as number,
    column: best.srcCol as number,
    name: best.nameIndex === undefined ? undefined : nonEmpty(map.names[best.nameIndex]),
  };
}

/**
 * Reference composition: expand one generated (line, column) through both maps
 * directly, taking the last non-empty name along the chain.
 */
export function referenceCompose(
  outer: SourceMapData,
  inner: SourceMapData,
  line: number,
  column: number,
): Mapping | null {
  const mid = referenceQuery(outer, line, column);
  if (mid === null) return null;
  const hit = referenceQuery(inner, mid.line, mid.column);
  if (hit === null) return null;
  const sourceIndex = inner.sources.indexOf(hit.source);
  return {
    source: hit.source,
    sourceIndex,
    line: hit.line,
    column: hit.column,
    name: hit.name ?? mid.name,
  };
}

/** Inclusive [maxLine, maxColumn] extent of a map's generated side. */
export function generatedExtent(map: SourceMapData): { maxLine: number; maxColumn: number } {
  let maxLine = 0;
  let maxColumn = 0;
  for (const seg of map.segments) {
    if (seg.genLine > maxLine) maxLine = seg.genLine;
    if (seg.genCol > maxColumn) maxColumn = seg.genCol;
  }
  return { maxLine, maxColumn };
}
