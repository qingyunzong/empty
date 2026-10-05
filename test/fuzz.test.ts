import { test } from 'node:test';
import { deepStrictEqual } from 'node:assert/strict';
import {
  compose,
  indexMap,
  originalPositionFor,
  parseMappings,
  serializeMappings,
} from '../src/index.js';
import {
  generatedExtent,
  mulberry32,
  randomMap,
  referenceCompose,
  referenceQuery,
} from './helpers.js';
import type { RandomMapOptions } from './helpers.js';
import type { Mapping } from '../src/index.js';

/** Compare positions by value; source indices differ after re-interning. */
function normalize(m: Mapping | null): Pick<Mapping, 'source' | 'line' | 'column' | 'name'> | null {
  if (m === null) return null;
  return { source: m.source, line: m.line, column: m.column, name: m.name };
}

const SPARSE: RandomMapOptions = {
  maxLines: 7,
  maxSegmentsPerLine: 5,
  maxColumn: 24,
  sourceCount: 3,
  nameCount: 4,
  unmappedChance: 0.25,
  nameChance: 0.5,
  emptyNameChance: 0.15,
  targetLineSlack: 2,
  targetColSlack: 3,
};

const DENSE: RandomMapOptions = {
  maxLines: 6,
  maxSegmentsPerLine: 8,
  maxColumn: 16,
  sourceCount: 2,
  nameCount: 3,
  unmappedChance: 0.05,
  nameChance: 0.7,
  emptyNameChance: 0.1,
  targetLineSlack: 0,
  targetColSlack: 1,
};

function checkComposition(options: RandomMapOptions, seeds: number, seedBase: number): string {
  let comparisons = 0;
  let mapped = 0;
  let unmapped = 0;
  for (let seed = seedBase; seed < seedBase + seeds; seed++) {
    const rng = mulberry32(seed);
    const outer = randomMap(rng, options);
    const inner = randomMap(rng, options);
    // Compose, then round-trip through the compressed VLQ output so the
    // check covers the emitted mappings string, not just decoded segments.
    const composedDecoded = compose(outer, inner);
    const compressed = serializeMappings(composedDecoded);
    const reparsed = parseMappings(compressed, composedDecoded.sources, composedDecoded.names);
    deepStrictEqual(reparsed.segments, composedDecoded.segments, `seed ${seed}: round-trip`);

    const indexed = indexMap(reparsed);
    const { maxLine, maxColumn } = generatedExtent(outer);
    for (let line = 0; line <= maxLine + 1; line++) {
      for (let column = 0; column <= maxColumn + 2; column++) {
        const expected = referenceCompose(outer, inner, line, column);
        const actual = originalPositionFor(indexed, line, column);
        deepStrictEqual(
          normalize(actual),
          normalize(expected),
          `seed ${seed} at generated ${line}:${column}`,
        );
        comparisons++;
        if (actual === null) unmapped++;
        else mapped++;
      }
    }
  }
  return `seeds=${seeds} columns compared=${comparisons} mapped=${mapped} unmapped=${unmapped}`;
}

test('composed map matches the column-by-column reference model (sparse)', (t) => {
  t.diagnostic(checkComposition(SPARSE, 400, 1));
});

test('composed map matches the column-by-column reference model (dense)', (t) => {
  t.diagnostic(checkComposition(DENSE, 400, 5001));
});

test('reference model agrees with library queries on single maps', (t) => {
  const seeds = 200;
  let comparisons = 0;
  for (let seed = 1001; seed < 1001 + seeds; seed++) {
    const rng = mulberry32(seed);
    const m = randomMap(rng, SPARSE);
    const indexed = indexMap(m);
    const { maxLine, maxColumn } = generatedExtent(m);
    for (let line = 0; line <= maxLine + 1; line++) {
      for (let column = 0; column <= maxColumn + 2; column++) {
        deepStrictEqual(
          normalize(originalPositionFor(indexed, line, column)),
          normalize(referenceQuery(m, line, column)),
          `seed ${seed} at generated ${line}:${column}`,
        );
        comparisons++;
      }
    }
  }
  t.diagnostic(`seeds=${seeds} columns compared=${comparisons}`);
});
