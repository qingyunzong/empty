// Manifest handling. The manifest is the only mutable metadata and is always
// updated atomically: write a temp file, fsync, then rename over the old
// manifest. A crash before the rename leaves the previous manifest intact.

import fs from 'node:fs';
import path from 'node:path';
import { PackError, E_MANIFEST } from './errors.js';

export const MANIFEST_NAME = 'manifest.json';
export const PACK_FILE_NAME = 'labels.plp';

export function manifestPath(dir) {
  return path.join(dir, MANIFEST_NAME);
}

export function packPath(dir) {
  return path.join(dir, PACK_FILE_NAME);
}

export function readManifest(dir) {
  const file = manifestPath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new PackError(E_MANIFEST, `cannot read manifest: ${err.message}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new PackError(E_MANIFEST, 'manifest is not valid JSON');
  }
  if (manifest.format !== 'labelpack/1') {
    throw new PackError(E_MANIFEST, `unsupported manifest format ${JSON.stringify(manifest.format)}`);
  }
  return manifest;
}

export function writeManifestAtomic(dir, manifest) {
  const tmp = path.join(dir, `.${MANIFEST_NAME}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, manifestPath(dir));
}

export function initialManifest() {
  return {
    format: 'labelpack/1',
    packFile: PACK_FILE_NAME,
    currentDictVersion: 0,
    dictionaries: [],
    updatedAt: new Date().toISOString(),
  };
}
