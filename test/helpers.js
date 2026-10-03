import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qc-test-'));
}

export const T0 = Date.parse('2026-01-01T00:00:00.000Z');
export const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
