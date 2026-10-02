import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'auditlog-'));
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function makeRecords(tenant, count, { startSeq = 0, size = 40 } = {}) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    records.push({ tenant, seq: startSeq + i, data: 'x'.repeat(size) });
  }
  return records;
}
