import test from 'node:test';
import assert from 'node:assert/strict';
import { createPack, addDictionary, appendLabels, appendBlocks } from '../src/writer.js';
import { decodePack, readIndex } from '../src/reader.js';
import { buildDictionary, encodeRecordsPayload } from '../src/dictionary.js';
import { BLOCK_TYPE } from '../src/format.js';
import { E_DICT, E_CRC, E_DICTREF } from '../src/errors.js';
import { tmpDir, corruptBlockPayload, GTIN_A, GTIN_B, BATCH_A, BATCH_B, WS_MULTIBYTE } from '../testutil/helpers.js';

const OLD_LABELS = [
  { gtin: GTIN_A, batch: BATCH_A, serial: 'OLD-1', workstation: WS_MULTIBYTE, timestamp: 1000 },
];
const NEW_LABELS = [
  { gtin: GTIN_B, batch: BATCH_B, serial: 'NEW-1', workstation: WS_MULTIBYTE, timestamp: 2000 },
];

function twoGenerationPack() {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, { gtin: [GTIN_A], batch: [BATCH_A], workstation: [WS_MULTIBYTE] }); // v1
  appendLabels(dir, OLD_LABELS);
  addDictionary(dir, { gtin: [GTIN_B], batch: [BATCH_B] }); // v2 = v1 + new values
  appendLabels(dir, NEW_LABELS);
  return dir;
}

test('corrupt old dictionary only poisons records bound to it (E_DICT)', () => {
  const dir = twoGenerationPack();
  const index = readIndex(dir);
  const dictV1 = index.find((e) => e.type === BLOCK_TYPE.DICT && e.version === 1);
  corruptBlockPayload(dir, dictV1, 4); // inside entry bytes

  const { labels, errors } = decodePack(dir);
  const dictErrors = errors.filter((e) => e.code === E_DICT);
  assert.ok(dictErrors.length >= 1, 'E_DICT reported');
  assert.ok(dictErrors.some((e) => e.version === 1 || e.dictVersion === 1));

  // Records bound to v1 are gone, records bound to v2 still decode.
  assert.deepStrictEqual(labels.map((l) => l.serial), ['NEW-1']);
  assert.ok(labels.every((l) => l.dictVersion === 2));
  assert.equal(labels[0].gtin, GTIN_B);
  assert.equal(labels[0].workstation, WS_MULTIBYTE);
});

test('corrupt record block yields E_CRC and other blocks still decode', () => {
  const dir = twoGenerationPack();
  const index = readIndex(dir);
  const recordBlock = index.find((e) => e.type === BLOCK_TYPE.RECORDS && e.version === 2);
  corruptBlockPayload(dir, recordBlock, 20);

  const { labels, errors } = decodePack(dir);
  assert.ok(errors.some((e) => e.code === E_CRC && e.version === 2));
  assert.deepStrictEqual(labels.map((l) => l.serial), ['OLD-1']);
});

test('record block bound to an unknown dictionary version yields E_DICTREF', () => {
  const dir = twoGenerationPack();
  const ghost = buildDictionary(99, { gtin: ['x'], batch: ['y'], workstation: ['z'] });
  const payload = encodeRecordsPayload(ghost, [
    { gtin: 'x', batch: 'y', serial: 'GHOST', workstation: 'z', timestamp: 1 },
  ]);
  appendBlocks(dir, [{ type: BLOCK_TYPE.RECORDS, version: 99, payload }]);

  const { labels, errors } = decodePack(dir);
  assert.ok(errors.some((e) => e.code === E_DICTREF && e.dictVersion === 99));
  assert.deepStrictEqual(labels.map((l) => l.serial), ['OLD-1', 'NEW-1']);
});

test('record referencing an unknown dictionary entry id yields E_DICTREF', () => {
  const dir = twoGenerationPack();
  const dict = buildDictionary(2, {
    gtin: [GTIN_A, GTIN_B], batch: [BATCH_A, BATCH_B], workstation: [WS_MULTIBYTE],
  });
  const payload = encodeRecordsPayload(dict, [
    { gtin: GTIN_A, batch: BATCH_A, serial: 'BAD-REF', workstation: WS_MULTIBYTE, timestamp: 5 },
    { gtin: GTIN_B, batch: BATCH_B, serial: 'GOOD', workstation: WS_MULTIBYTE, timestamp: 6 },
  ]);
  payload.writeUInt32LE(999, 16); // first record: gtinId out of range
  appendBlocks(dir, [{ type: BLOCK_TYPE.RECORDS, version: 2, payload }]);

  const { labels, errors } = decodePack(dir);
  assert.ok(errors.some((e) => e.code === E_DICTREF && e.recordIndex === 0));
  // The healthy record in the same block survives.
  assert.ok(labels.some((l) => l.serial === 'GOOD'));
  assert.ok(!labels.some((l) => l.serial === 'BAD-REF'));
});

test('record referencing an entry of the wrong field yields E_DICTREF', () => {
  const dir = twoGenerationPack();
  const dict = buildDictionary(2, {
    gtin: [GTIN_A, GTIN_B], batch: [BATCH_A, BATCH_B], workstation: [WS_MULTIBYTE],
  });
  const payload = encodeRecordsPayload(dict, [
    { gtin: GTIN_A, batch: BATCH_A, serial: 'X-FIELD', workstation: WS_MULTIBYTE, timestamp: 5 },
  ]);
  const batchId = payload.readUInt32LE(20);
  payload.writeUInt32LE(batchId, 16); // gtinId now points at a batch entry
  appendBlocks(dir, [{ type: BLOCK_TYPE.RECORDS, version: 2, payload }]);

  const { errors } = decodePack(dir);
  assert.ok(errors.some((e) => e.code === E_DICTREF));
});
