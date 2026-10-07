// Pack writer. Blocks are append-only; the trailing index is rewritten in
// place on each append (truncate to the old index offset, append new blocks,
// write a fresh index + trailer). Dictionary updates go through the manifest
// temp-file + rename dance so a new version only becomes visible atomically.

import fs from 'node:fs';
import {
  BLOCK_TYPE,
  FILE_HEADER_SIZE,
  TRAILER_SIZE,
  encodeFileHeader,
  encodeBlock,
  encodeIndex,
  encodeTrailer,
  parseIndex,
  parseTrailer,
} from './format.js';
import {
  buildDictionary,
  encodeDictionaryPayload,
  encodeRecordsPayload,
  normalizeString,
  normalizeTimestamp,
} from './dictionary.js';
import {
  initialManifest,
  packPath,
  readManifest,
  writeManifestAtomic,
} from './manifest.js';
import { readDictionaryVersion } from './reader.js';
import { PackError, E_DICTREF } from './errors.js';

export function createPack(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = packPath(dir);
  if (fs.existsSync(file)) {
    throw new PackError('E_ARG', `pack already exists in ${dir}`);
  }
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeSync(fd, encodeFileHeader());
    fs.writeSync(fd, encodeIndex([]));
    fs.writeSync(fd, encodeTrailer(FILE_HEADER_SIZE));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  writeManifestAtomic(dir, initialManifest());
}

function readIndexFromFd(fd, size) {
  if (size < FILE_HEADER_SIZE + TRAILER_SIZE) {
    throw new PackError('E_FORMAT', 'file too small');
  }
  const trailerBuf = Buffer.alloc(TRAILER_SIZE);
  fs.readSync(fd, trailerBuf, 0, TRAILER_SIZE, size - TRAILER_SIZE);
  const { indexOffset } = parseTrailer(trailerBuf);
  const indexBuf = Buffer.alloc(size - TRAILER_SIZE - indexOffset);
  fs.readSync(fd, indexBuf, 0, indexBuf.length, indexOffset);
  return { indexOffset, entries: parseIndex(indexBuf) };
}

// Appends raw blocks and rewrites the trailing index. Each block is
// { type, version, payload }. Returns the index entries for the new blocks.
export function appendBlocks(dir, blocks) {
  const file = packPath(dir);
  const fd = fs.openSync(file, 'r+');
  try {
    const size = fs.fstatSync(fd).size;
    const { indexOffset, entries } = readIndexFromFd(fd, size);
    fs.ftruncateSync(fd, indexOffset);
    let offset = indexOffset;
    const added = [];
    for (const block of blocks) {
      const raw = encodeBlock(block.type, block.version, block.payload);
      fs.writeSync(fd, raw, 0, raw.length, offset);
      added.push({ offset, length: raw.length, type: block.type, version: block.version });
      offset += raw.length;
    }
    const all = entries.concat(added);
    const indexRaw = encodeIndex(all);
    fs.writeSync(fd, indexRaw, 0, indexRaw.length, offset);
    fs.writeSync(fd, encodeTrailer(offset), 0, TRAILER_SIZE, offset + indexRaw.length);
    fs.fsyncSync(fd);
    return added;
  } finally {
    fs.closeSync(fd);
  }
}

// Adds a new dictionary version. `values` are merged with the current
// dictionary (dictionaries are append-only snapshots). The new version takes
// effect only after the manifest temp file is renamed over the old manifest.
export function addDictionary(dir, values = {}) {
  const manifest = readManifest(dir);
  const previous = manifest.currentDictVersion > 0
    ? readDictionaryVersion(dir, manifest.currentDictVersion)
    : null;
  const merged = { gtin: [], batch: [], workstation: [] };
  if (previous) {
    for (const entry of previous.entries) merged[entry.field].push(entry.value);
  }
  for (const field of ['gtin', 'batch', 'workstation']) {
    for (const value of values[field] ?? []) merged[field].push(value);
  }
  const version = manifest.currentDictVersion + 1;
  const dict = buildDictionary(version, merged);
  const [entry] = appendBlocks(dir, [
    { type: BLOCK_TYPE.DICT, version, payload: encodeDictionaryPayload(dict) },
  ]);
  const next = {
    ...manifest,
    currentDictVersion: version,
    dictionaries: manifest.dictionaries.concat([
      {
        version,
        offset: entry.offset,
        length: entry.length,
        entries: dict.entries.length,
        addedAt: new Date().toISOString(),
      },
    ]),
    updatedAt: new Date().toISOString(),
  };
  writeManifestAtomic(dir, next);
  return dict;
}

function normalizeLabel(label) {
  return {
    gtin: normalizeString(label.gtin),
    batch: normalizeString(label.batch),
    workstation: normalizeString(label.workstation),
    serial: normalizeString(label.serial),
    timestamp: normalizeTimestamp(label.timestamp),
  };
}

// Appends one record delta block bound to the current dictionary version.
// With autoDict, missing dictionary values first trigger a new dictionary
// version (via the atomic manifest rename path).
export function appendLabels(dir, labels, { autoDict = false } = {}) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new PackError('E_ARG', 'no labels to append');
  }
  const normalized = labels.map(normalizeLabel);
  let manifest = readManifest(dir);
  if (manifest.currentDictVersion === 0) {
    if (!autoDict) throw new PackError(E_DICTREF, 'no dictionary version yet');
    addDictionary(dir, collectValues(normalized));
    manifest = readManifest(dir);
  }
  let dict = readDictionaryVersion(dir, manifest.currentDictVersion);
  const missing = collectMissing(dict, normalized);
  if (missing) {
    if (!autoDict) {
      throw new PackError(E_DICTREF, `values not in dictionary v${dict.version}: ${missing}`);
    }
    dict = addDictionary(dir, collectValues(normalized));
  }
  const payload = encodeRecordsPayload(dict, normalized);
  appendBlocks(dir, [{ type: BLOCK_TYPE.RECORDS, version: dict.version, payload }]);
  return { dictVersion: dict.version, count: normalized.length };
}

function collectValues(labels) {
  const values = { gtin: [], batch: [], workstation: [] };
  for (const label of labels) {
    values.gtin.push(label.gtin);
    values.batch.push(label.batch);
    values.workstation.push(label.workstation);
  }
  return values;
}

function collectMissing(dict, labels) {
  const missing = [];
  for (const label of labels) {
    for (const field of ['gtin', 'batch', 'workstation']) {
      if (dict.idOf(field, label[field]) === undefined) {
        missing.push(`${field}=${JSON.stringify(label[field])}`);
      }
    }
  }
  return missing.length ? missing.join(', ') : null;
}
