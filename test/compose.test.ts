import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { composeSourceMaps } from '../src/compose.js';
import { parseSourceMap } from '../src/mappings.js';
import { originalPositionFor } from '../src/query.js';
import type { SourceMapData } from '../src/types.js';

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

test('composes to the hand-computed compressed mappings', () => {
  const composed = composeSourceMaps(outer, inner);
  deepEqual(composed, {
    version: 3,
    sources: ['orig.ts'],
    names: ['alpha'],
    mappings: 'AAAAA,KAEI;;GAAA,O',
  });
});

test('inner name wins over outer name (last non-empty propagates)', () => {
  const composed = parseSourceMap(composeSourceMaps(outer, inner));
  deepEqual(originalPositionFor(composed, 0, 0), {
    source: 'orig.ts',
    line: 0,
    column: 0,
    name: 'alpha',
  });
});

test('outer name survives when the inner segment has none', () => {
  const namedOuter: SourceMapData = {
    version: 3,
    sources: ['mid.js'],
    names: ['mid'],
    mappings: 'AAAYA',
  };
  const composed = composeSourceMaps(namedOuter, inner);
  equal(composed.mappings, 'AAEIA');
  deepEqual(composed.names, ['mid']);
  deepEqual(originalPositionFor(parseSourceMap(composed), 0, 0), {
    source: 'orig.ts',
    line: 2,
    column: 4,
    name: 'mid',
  });
});

test('inner name applies when the outer segment has none', () => {
  const plainOuter: SourceMapData = {
    version: 3,
    sources: ['mid.js'],
    names: [],
    mappings: 'AAAA',
  };
  const composed = composeSourceMaps(plainOuter, inner);
  equal(composed.mappings, 'AAAAA');
  deepEqual(composed.names, ['alpha']);
});

test('segments with no inner mapping stay unmapped without borrowing across lines', () => {
  const sparseInner: SourceMapData = {
    version: 3,
    sources: ['orig.ts'],
    names: [],
    mappings: ';;AAAA',
  };
  const reachingOuter: SourceMapData = {
    version: 3,
    sources: ['mid.js'],
    names: [],
    mappings: 'AAAA,IAEA',
  };
  const composed = parseSourceMap(composeSourceMaps(reachingOuter, sparseInner));
  equal(originalPositionFor(composed, 0, 0), null);
  deepEqual(originalPositionFor(composed, 0, 4), {
    source: 'orig.ts',
    line: 0,
    column: 0,
    name: undefined,
  });
});

test('outer segments pointing past the inner map become generated-only segments', () => {
  const farOuter: SourceMapData = {
    version: 3,
    sources: ['mid.js'],
    names: [],
    mappings: 'AAAA,IAIA',
  };
  const tinyInner: SourceMapData = { version: 3, sources: ['o.ts'], names: [], mappings: 'AAAA' };
  const composed = composeSourceMaps(farOuter, tinyInner);
  equal(composed.mappings, 'AAAA,I');
  deepEqual(composed.sources, ['o.ts']);
});

test('empty outer mappings compose to empty mappings', () => {
  const emptyOuter: SourceMapData = { version: 3, sources: [], names: [], mappings: '' };
  const composed = composeSourceMaps(emptyOuter, inner);
  equal(composed.mappings, '');
  deepEqual(composed.sources, []);
  deepEqual(composed.names, []);
});
