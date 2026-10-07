import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Strip the correction version so rows can be compared with the reference.
export function stripVersion(row) {
  const { version, ...rest } = row;
  return rest;
}
