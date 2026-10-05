import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { parseSourceMap } from '../src/mappings.js';
import { originalPositionFor } from '../src/query.js';
import type { SourceMapData } from '../src/types.js';

const map: SourceMapData = {
  version: 3,
  sources: ['orig.ts'],
  names: ['alpha'],
  mappings: 'AAAAA,UAEI;;GAAA,O',
};
const parsed = parseSourceMap(map);

test('exact segment column resolves to that segment', () => {
  deepEqual(originalPositionFor(parsed, 0, 0), {
    source: 'orig.ts',
    line: 0,
    column: 0,
    name: 'alpha',
  });
  deepEqual(originalPositionFor(parsed, 0, 10), {
    source: 'orig.ts',
    line: 2,
    column: 4,
    name: undefined,
  });
});

test('nearest left segment on the same line wins', () => {
  deepEqual(originalPositionFor(parsed, 0, 1), originalPositionFor(parsed, 0, 0));
  deepEqual(originalPositionFor(parsed, 0, 9), originalPositionFor(parsed, 0, 0));
  deepEqual(originalPositionFor(parsed, 0, 500), originalPositionFor(parsed, 0, 10));
});

test('column before the first segment is unmapped', () => {
  equal(originalPositionFor(parsed, 2, 0), null);
  equal(originalPositionFor(parsed, 2, 2), null);
});

test('generated-only segment blocks lookup until the next segment', () => {
  deepEqual(originalPositionFor(parsed, 2, 3), {
    source: 'orig.ts',
    line: 2,
    column: 4,
    name: undefined,
  });
  equal(originalPositionFor(parsed, 2, 10), null);
  equal(originalPositionFor(parsed, 2, 999), null);
});

test('never borrows positions across lines', () => {
  equal(originalPositionFor(parsed, 1, 0), null);
  equal(originalPositionFor(parsed, 1, 100), null);
  equal(originalPositionFor(parsed, 3, 0), null);
  equal(originalPositionFor(parsed, 99, 0), null);
  equal(originalPositionFor(parsed, -1, 0), null);
});
