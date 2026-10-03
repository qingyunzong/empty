import fs from 'node:fs';
import path from 'node:path';
import { CrashInjected, PackError } from './errors.js';

export const OUTBOX_FILES = ['cases.jsonl', 'release.json', 'late.log'];
export const WAL_FILE = 'wal.jsonl';

const tmpName = (f) => `${f}.tmp`;

// Recovery step 1: a leftover outbox tmp means we crashed between writing the
// tmp and the atomic rename, so the half-published outbox is discarded.
export function discardStaleOutbox(outDir) {
  for (const f of OUTBOX_FILES) {
    const tmp = path.join(outDir, tmpName(f));
    if (fs.existsSync(tmp)) fs.rmSync(tmp);
  }
}

// Recovery step 2: replay the WAL. A torn trailing line (crash mid-append) is
// tolerated; corruption anywhere else is fatal.
export function readWal(outDir) {
  const file = path.join(outDir, WAL_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const records = [];
  lines.forEach((line, idx) => {
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      if (idx !== lines.length - 1) {
        throw new PackError('WAL_CORRUPT', `${WAL_FILE}:${idx + 1}: ${err.message}`);
      }
    }
  });
  return records;
}

export function appendWal(outDir, seq, event) {
  fs.appendFileSync(path.join(outDir, WAL_FILE), `${JSON.stringify({ seq, event })}\n`);
}

function writeTmpFsync(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Outbox protocol: write every <name>.tmp, fsync, then rename into place.
// crashPoint simulates the persisted fault point for tests/CLI.
export function writeOutputs(outDir, outputs, crashPoint = null) {
  for (const f of OUTBOX_FILES) {
    writeTmpFsync(path.join(outDir, tmpName(f)), outputs[f]);
  }
  if (crashPoint === 'before-rename') throw new CrashInjected('before-rename');
  for (const f of OUTBOX_FILES) {
    fs.renameSync(path.join(outDir, tmpName(f)), path.join(outDir, f));
  }
  if (crashPoint === 'after-rename') throw new CrashInjected('after-rename');
}
