import test from 'node:test';
import assert from 'node:assert/strict';
import { createPack, addDictionary, appendLabels } from '../src/writer.js';
import { dumpLabels, decodePack, readIndex, decodeRecordBlockAt } from '../src/reader.js';
import { tmpDir, sampleLabels, sampleDictValues, expectedNormalized } from '../testutil/helpers.js';

test('small label set matches independent normalized JSON enumeration', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, sampleDictValues());
  appendLabels(dir, sampleLabels().slice(0, 2));
  appendLabels(dir, sampleLabels().slice(2)); // second delta block, same dict

  const { labels, errors } = dumpLabels(dir);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(labels, expectedNormalized());
});

test('decodePack exposes dict binding and clean error list', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, sampleDictValues());
  appendLabels(dir, sampleLabels());
  const { labels, errors, dictionaries } = decodePack(dir);
  assert.equal(errors.length, 0);
  assert.equal(labels.length, 3);
  assert.ok(labels.every((l) => l.dictVersion === 1));
  assert.equal(dictionaries.get(1).entries.length, 5);
});

test('random-access index decodes a single record block', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, sampleDictValues());
  appendLabels(dir, sampleLabels().slice(0, 2));
  appendLabels(dir, sampleLabels().slice(2));

  const index = readIndex(dir);
  assert.equal(index.length, 3);
  assert.deepStrictEqual(index.map((e) => e.type), [1, 2, 2]);

  const block = decodeRecordBlockAt(dir, 2);
  assert.equal(block.dictVersion, 1);
  assert.equal(block.labels.length, 1);
  assert.equal(block.labels[0].serial, '序列-③');
  assert.equal(block.labels[0].workstation, '包装线α-①😀');
  assert.equal(block.labels[0].timestamp, 1790000002500);
});

test('decomposed unicode input is normalized to NFC on write', () => {
  const dir = tmpDir();
  createPack(dir);
  const decomposed = 'é station'; // é as e + U+0301
  addDictionary(dir, { workstation: [decomposed] });
  appendLabels(dir, [{ gtin: '1', batch: '2', serial: '3', workstation: decomposed, timestamp: 0 }], { autoDict: true });
  const { labels } = dumpLabels(dir);
  assert.equal(labels[0].workstation, 'é station'.normalize('NFC'));
});
