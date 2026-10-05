import { test } from 'node:test';
import { deepEqual, equal } from 'node:assert/strict';
import { parseMappings, serializeMappings } from '../src/mappings.js';

test('parses mapped, named, and generated-only segments', () => {
  const lines = parseMappings('AAAAA,KAAY;;GAA8B,O');
  equal(lines.length, 3);
  deepEqual(lines[0], [
    { genCol: 0, src: 0, srcLine: 0, srcCol: 0, name: 0 },
    { genCol: 5, src: 0, srcLine: 0, srcCol: 12, name: -1 },
  ]);
  deepEqual(lines[1], []);
  deepEqual(lines[2], [
    { genCol: 3, src: 0, srcLine: 0, srcCol: 42, name: -1 },
    { genCol: 10, src: -1, srcLine: -1, srcCol: -1, name: -1 },
  ]);
});

test('serialize(parse(x)) is the identity for spec-compliant input', () => {
  for (const mappings of [
    '',
    'AAAA',
    'AAAAA,KAAY;;GAA8B,O',
    ';;;AAAA',
    'A,EAAK;ACAL,IAAI',
    'uCAAOA',
  ]) {
    equal(serializeMappings(parseMappings(mappings)), mappings, `round-trip ${mappings}`);
  }
});

test('relative deltas persist across lines for source fields', () => {
  const lines = parseMappings('ACAA;AAAA');
  deepEqual(lines[0], [{ genCol: 0, src: 1, srcLine: 0, srcCol: 0, name: -1 }]);
  deepEqual(lines[1], [{ genCol: 0, src: 1, srcLine: 0, srcCol: 0, name: -1 }]);
});
