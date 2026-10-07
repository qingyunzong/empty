import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPack, addDictionary, appendLabels } from '../src/writer.js';
import { decodePack } from '../src/reader.js';
import { readManifest } from '../src/manifest.js';
import { tmpDir, GTIN_A, GTIN_B, BATCH_A, WS_MULTIBYTE } from '../testutil/helpers.js';

test('new dictionary version takes effect via manifest temp file + rename', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, { gtin: [GTIN_A], batch: [BATCH_A], workstation: [WS_MULTIBYTE] });
  const v2 = addDictionary(dir, { gtin: [GTIN_B] });

  assert.equal(v2.version, 2);
  const manifest = readManifest(dir);
  assert.equal(manifest.currentDictVersion, 2);
  assert.deepStrictEqual(manifest.dictionaries.map((d) => d.version), [1, 2]);

  // No temp files left behind after the atomic rename.
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepStrictEqual(leftovers, []);

  // Manifest on disk is valid JSON and matches.
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(onDisk.currentDictVersion, 2);
});

test('old records stay bound to their dictionary version forever', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, { gtin: [GTIN_A], batch: [BATCH_A], workstation: [WS_MULTIBYTE] });
  appendLabels(dir, [{ gtin: GTIN_A, batch: BATCH_A, serial: 'GEN-1', workstation: WS_MULTIBYTE, timestamp: 1 }]);
  addDictionary(dir, { gtin: [GTIN_B] });
  appendLabels(dir, [{ gtin: GTIN_B, batch: BATCH_A, serial: 'GEN-2', workstation: WS_MULTIBYTE, timestamp: 2 }]);

  const { labels, errors } = decodePack(dir);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(
    labels.map((l) => [l.serial, l.dictVersion]),
    [['GEN-1', 1], ['GEN-2', 2]],
  );
});

test('dictionary versions are append-only snapshots (v1 keeps its entry set)', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, { gtin: [GTIN_A], batch: [BATCH_A], workstation: [WS_MULTIBYTE] });
  addDictionary(dir, { gtin: [GTIN_B] });
  const { dictionaries } = decodePack(dir);
  assert.equal(dictionaries.get(1).entries.length, 3);
  assert.equal(dictionaries.get(2).entries.length, 4);
  assert.equal(dictionaries.get(1).idOf('gtin', GTIN_B), undefined);
  assert.notEqual(dictionaries.get(2).idOf('gtin', GTIN_B), undefined);
});

test('append without auto-dict rejects values missing from the dictionary', () => {
  const dir = tmpDir();
  createPack(dir);
  addDictionary(dir, { gtin: [GTIN_A], batch: [BATCH_A], workstation: [WS_MULTIBYTE] });
  assert.throws(
    () => appendLabels(dir, [{ gtin: GTIN_B, batch: BATCH_A, serial: 'S', workstation: WS_MULTIBYTE, timestamp: 1 }]),
    /not in dictionary/,
  );
  // auto-dict creates a new version through the manifest rename path.
  const result = appendLabels(dir, [{ gtin: GTIN_B, batch: BATCH_A, serial: 'S', workstation: WS_MULTIBYTE, timestamp: 1 }], { autoDict: true });
  assert.equal(result.dictVersion, 2);
  assert.equal(readManifest(dir).currentDictVersion, 2);
});
