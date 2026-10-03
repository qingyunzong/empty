import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function tempDir() {
  return mkdtempSync(path.join(tmpdir(), 'frozen-ledger-'));
}
