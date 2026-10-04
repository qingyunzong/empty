import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  encodePrograms,
  encodeBlock,
  parseBlocks,
  writePackage,
  readPackage,
  DATA_FILE,
  INDEX_FILE,
} from '../src/codec.js';

const MAIN = ['N1 G21 G90', 'M98 Psub', 'GOTO N10', 'G1 X999', 'N10 G1 X1', 'M30'].join('\n');
const SUB = ['N1 G91', 'G1 X5', 'M99'].join('\n');
const SOURCES = [
  { name: 'main', text: MAIN },
  { name: 'sub', text: SUB },
];

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cnc-pack-'));
}

test('encodePrograms assigns contiguous seq ranges and entry offsets', () => {
  const { index, data } = encodePrograms(SOURCES, { blockLines: 2 });
  assert.equal(index.main, 'main');
  assert.deepEqual(index.programs.main, { start: 0, end: 2, entry: 0 });
  assert.deepEqual(index.programs.sub, { start: 3, end: 4, entry: 0 });
  assert.equal(index.blockCount, 5);
  const blocks = parseBlocks(data);
  assert.equal(blocks.size, 5);
  assert.equal(blocks.get(0).payload.toString(), 'N1 G21 G90\nM98 Psub');
  assert.equal(blocks.get(4).payload.toString(), 'M99');
});

test('writePackage commits via rename and leaves no temp files', () => {
  const dir = tmpdir();
  writePackage(dir, SOURCES, { blockLines: 2 });
  assert.ok(fs.existsSync(path.join(dir, DATA_FILE)));
  assert.ok(fs.existsSync(path.join(dir, INDEX_FILE)));
  assert.ok(!fs.existsSync(path.join(dir, DATA_FILE + '.tmp')));
  assert.ok(!fs.existsSync(path.join(dir, INDEX_FILE + '.tmp')));
  const { index, blocks } = readPackage(dir);
  assert.equal(index.blockCount, 5);
  assert.equal(blocks.size, 5);
});

test('unindexed tail is ignored (crash before index rename)', () => {
  const dir = tmpdir();
  writePackage(dir, SOURCES, { blockLines: 2 });
  const dataPath = path.join(dir, DATA_FILE);
  // simulate blocks written to the data file but never committed to the index
  const extra = encodeBlock(5, Buffer.from('G1 X1\nG1 X2'));
  const partial = Buffer.from([1, 2, 3]); // truncated block from a torn write
  fs.appendFileSync(dataPath, Buffer.concat([extra, partial]));
  const { index, blocks } = readPackage(dir);
  assert.equal(index.blockCount, 5);
  assert.equal(blocks.size, 5);
  assert.ok(!blocks.has(5));
});
