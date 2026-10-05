import { test } from 'node:test';
import { composeSourceMaps } from '../src/compose.js';
import { parseMappings, parseSourceMap, serializeMappings } from '../src/mappings.js';
import { deepEqual, equal } from 'node:assert/strict';
import {
  assertComposedEqualsReference,
  mulberry32,
  randomMap,
  refCompose,
} from './helpers.js';
import type { SourceMapData } from '../src/types.js';

test('hand-built fixture matches the reference model column by column', () => {
  const inner: SourceMapData = {
    version: 3,
    sources: ['orig.ts'],
    names: ['alpha'],
    mappings: 'AAAAA,UAEI',
  };
  const outer: SourceMapData = {
    version: 3,
    sources: ['mid.js'],
    names: ['midName'],
    mappings: 'AAAAA,KAAY;;GAA8B,O',
  };
  assertComposedEqualsReference(outer, inner);
});

test('boundary fixtures: empty lines, empty maps, unmapped runs', () => {
  const fixtures: Array<[SourceMapData, SourceMapData]> = [
    [
      { version: 3, sources: [], names: [], mappings: '' },
      { version: 3, sources: [], names: [], mappings: '' },
    ],
    [
      { version: 3, sources: ['m.js'], names: [], mappings: ';;;AAAA' },
      { version: 3, sources: ['o.ts'], names: [], mappings: 'AAAA' },
    ],
    [
      { version: 3, sources: ['m.js'], names: [], mappings: 'A,KAAK,I' },
      { version: 3, sources: ['o.ts'], names: ['n'], mappings: 'AAAAA,K,KAAK' },
    ],
    [
      { version: 3, sources: ['m.js'], names: ['x'], mappings: 'A,IACAA' },
      { version: 3, sources: ['o.ts'], names: [], mappings: ';AAAA' },
    ],
  ];
  for (const [outer, inner] of fixtures) assertComposedEqualsReference(outer, inner);
});

test('seeded random maps: exhaustive column-by-column equivalence', () => {
  const rnd = mulberry32(0xc0ffee);
  for (let iter = 0; iter < 200; iter++) {
    const outer = randomMap(rnd, `o${iter}-`);
    const inner = randomMap(rnd, `i${iter}-`);
    assertComposedEqualsReference(outer, inner);
  }
});

test('composed output re-serializes to itself (canonical compressed form)', () => {
  const rnd = mulberry32(42);
  for (let iter = 0; iter < 50; iter++) {
    const composed = composeSourceMaps(randomMap(rnd, `a${iter}-`), randomMap(rnd, `b${iter}-`));
    const reparsed = parseMappings(composed.mappings);
    equal(serializeMappings(reparsed), composed.mappings);
  }
});

test('reference model sanity: two-step lookup matches direct expectations', () => {
  const inner: SourceMapData = {
    version: 3,
    sources: ['orig.ts'],
    names: ['alpha'],
    mappings: 'AAAAA,UAEI',
  };
  const outer: SourceMapData = {
    version: 3,
    sources: ['mid.js'],
    names: ['midName'],
    mappings: 'AAAAA,KAAY;;GAA8B,O',
  };
  const op = parseSourceMap(outer);
  const ip = parseSourceMap(inner);
  deepEqual(refCompose(op, ip, 0, 0), { source: 'orig.ts', line: 0, column: 0, name: 'alpha' });
  deepEqual(refCompose(op, ip, 0, 7), { source: 'orig.ts', line: 2, column: 4, name: undefined });
  equal(refCompose(op, ip, 1, 0), null);
  equal(refCompose(op, ip, 2, 15), null);
  deepEqual(refCompose(op, ip, 2, 5), { source: 'orig.ts', line: 2, column: 4, name: undefined });
});
