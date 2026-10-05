import { test } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import {
  compose,
  indexMap,
  originalPositionFor,
  parseMappings,
  serializeMappings,
} from '../src/index.js';
import type { SourceMapData } from '../src/index.js';

function map(partial: Partial<SourceMapData> & Pick<SourceMapData, 'segments'>): SourceMapData {
  return { version: 3, sources: ['a.ts', 'b.ts'], names: ['foo', 'bar', ''], ...partial };
}

test('query takes the nearest segment to the left on the same line', () => {
  const m = indexMap(
    map({
      segments: [
        { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 10, srcCol: 0 },
        { genLine: 0, genCol: 8, srcIndex: 1, srcLine: 20, srcCol: 4 },
      ],
    }),
  );
  strictEqual(originalPositionFor(m, 0, 0)?.line, 10);
  strictEqual(originalPositionFor(m, 0, 7)?.line, 10);
  strictEqual(originalPositionFor(m, 0, 8)?.line, 20);
  strictEqual(originalPositionFor(m, 0, 100)?.line, 20);
});

test('query never borrows positions across lines', () => {
  const m = indexMap(
    map({
      segments: [
        { genLine: 0, genCol: 3, srcIndex: 0, srcLine: 1, srcCol: 1 },
        { genLine: 2, genCol: 0, srcIndex: 0, srcLine: 2, srcCol: 2 },
      ],
    }),
  );
  strictEqual(originalPositionFor(m, 0, 2), null, 'before first segment of the line');
  strictEqual(originalPositionFor(m, 1, 50), null, 'empty line must not borrow from line 0');
  strictEqual(originalPositionFor(m, 5, 0), null, 'line past the end');
  strictEqual(originalPositionFor(m, 2, 0)?.line, 2);
});

test('unmapped segments stay unmapped and shadow earlier mapped segments', () => {
  const m = indexMap(
    map({
      segments: [
        { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 1, srcCol: 0 },
        { genLine: 0, genCol: 5 },
      ],
    }),
  );
  strictEqual(originalPositionFor(m, 0, 4)?.sourceIndex, 0);
  strictEqual(originalPositionFor(m, 0, 5), null, 'nearest-left segment is unmapped');
  strictEqual(originalPositionFor(m, 0, 99), null, 'unmapped segment extends to line end');
});

test('query reports the matched segment own name, empty means none', () => {
  const m = indexMap(
    map({
      segments: [
        { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 1, srcCol: 0, nameIndex: 0 },
        { genLine: 0, genCol: 4, srcIndex: 0, srcLine: 2, srcCol: 0 },
        { genLine: 0, genCol: 8, srcIndex: 0, srcLine: 3, srcCol: 0, nameIndex: 2 },
      ],
    }),
  );
  strictEqual(originalPositionFor(m, 0, 0)?.name, 'foo');
  strictEqual(originalPositionFor(m, 0, 4)?.name, undefined);
  strictEqual(originalPositionFor(m, 0, 8)?.name, undefined, 'empty-string name counts as none');
});

test('compressed mappings round-trip through parse and serialize', () => {
  const m = map({
    segments: [
      { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 10, srcCol: 0, nameIndex: 0 },
      { genLine: 0, genCol: 8, srcIndex: 1, srcLine: 20, srcCol: 4 },
      { genLine: 3, genCol: 2 },
      { genLine: 3, genCol: 7, srcIndex: 1, srcLine: 0, srcCol: 30, nameIndex: 1 },
    ],
  });
  const encoded = serializeMappings(m);
  const reparsed = parseMappings(encoded, m.sources, m.names);
  deepStrictEqual(reparsed.segments, m.segments);
  strictEqual(serializeMappings(reparsed), encoded);
});

test('parse decodes a minimal known mappings string', () => {
  const parsed = parseMappings('AAAA,IAACA', ['a.ts'], ['foo']);
  deepStrictEqual(parsed.segments, [
    { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 0, srcCol: 0 },
    { genLine: 0, genCol: 4, srcIndex: 0, srcLine: 0, srcCol: 1, nameIndex: 0 },
  ]);
});

test('serialize emits empty lines and unmapped segments compactly', () => {
  const m = map({
    segments: [
      { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 0, srcCol: 0 },
      { genLine: 2, genCol: 4 },
      { genLine: 2, genCol: 9, srcIndex: 1, srcLine: 3, srcCol: 2, nameIndex: 1 },
    ],
  });
  strictEqual(serializeMappings(m), 'AAAA;;I,KCGEC');
});

test('compose keeps unmapped segments and drops ones the inner map cannot place', () => {
  const outer = map({
    segments: [
      { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 0, srcCol: 0 },
      { genLine: 0, genCol: 4 },
      { genLine: 0, genCol: 8, srcIndex: 0, srcLine: 1, srcCol: 0 },
      { genLine: 0, genCol: 12, srcIndex: 0, srcLine: 9, srcCol: 0 },
    ],
  });
  const inner = map({
    sources: ['orig.ts'],
    segments: [{ genLine: 0, genCol: 0, srcIndex: 0, srcLine: 7, srcCol: 3 }],
  });
  const composed = compose(outer, inner);
  deepStrictEqual(composed.segments, [
    { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 7, srcCol: 3 },
    { genLine: 0, genCol: 4 },
    { genLine: 0, genCol: 8 },
    { genLine: 0, genCol: 12 },
  ]);
  deepStrictEqual(composed.sources, ['orig.ts']);
});

test('compose propagates the last non-empty name along the chain', () => {
  const outer = map({
    names: ['outerName', ''],
    segments: [
      { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 0, srcCol: 0, nameIndex: 0 },
      { genLine: 0, genCol: 4, srcIndex: 0, srcLine: 0, srcCol: 4 },
      { genLine: 0, genCol: 8, srcIndex: 0, srcLine: 0, srcCol: 8, nameIndex: 1 },
    ],
  });
  const inner = map({
    sources: ['orig.ts'],
    names: ['innerName'],
    segments: [
      { genLine: 0, genCol: 0, srcIndex: 0, srcLine: 0, srcCol: 0, nameIndex: 0 },
      { genLine: 0, genCol: 4, srcIndex: 0, srcLine: 1, srcCol: 0 },
      { genLine: 0, genCol: 8, srcIndex: 0, srcLine: 2, srcCol: 0 },
    ],
  });
  const composed = indexMap(compose(outer, inner));
  strictEqual(originalPositionFor(composed, 0, 0)?.name, 'innerName', 'inner name wins');
  strictEqual(originalPositionFor(composed, 0, 4)?.name, undefined, 'both empty');
  strictEqual(originalPositionFor(composed, 0, 8)?.name, undefined, 'empty outer name is none');
});

test('compose falls back to the outer name when the inner segment has none', () => {
  const outer = map({
    names: ['outerName'],
    segments: [{ genLine: 0, genCol: 0, srcIndex: 0, srcLine: 0, srcCol: 0, nameIndex: 0 }],
  });
  const inner = map({
    sources: ['orig.ts'],
    segments: [{ genLine: 0, genCol: 0, srcIndex: 0, srcLine: 5, srcCol: 5 }],
  });
  const composed = indexMap(compose(outer, inner));
  const hit = originalPositionFor(composed, 0, 0);
  strictEqual(hit?.name, 'outerName');
  strictEqual(hit?.source, 'orig.ts');
});
