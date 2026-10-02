import fs from 'node:fs';
import { AuditError } from './errors.js';

export const manifestPath = (file) => `${file}.manifest`;
export const manifestTmpPath = (file) => `${file}.manifest.tmp`;

// Recovery rules:
// - main missing, tmp present: crash between tmp write and rename -> adopt tmp.
// - main present, tmp present: crash before rename -> old manifest wins, drop stale tmp.
export function loadManifest(mftPath) {
  const tmp = `${mftPath}.tmp`;
  if (!fs.existsSync(mftPath)) {
    if (fs.existsSync(tmp)) {
      fs.renameSync(tmp, mftPath);
    } else {
      throw new AuditError('MANIFEST_MISSING', `manifest not found: ${mftPath}`);
    }
  } else if (fs.existsSync(tmp)) {
    fs.rmSync(tmp);
  }
  try {
    return JSON.parse(fs.readFileSync(mftPath, 'utf8'));
  } catch (err) {
    throw new AuditError('MANIFEST_CORRUPT', `manifest is not valid JSON: ${err.message}`);
  }
}

// Atomic replace: write temp region, fsync, then rename over the old manifest.
export function saveManifest(mftPath, manifest) {
  const tmp = `${mftPath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(manifest, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, mftPath);
}
