import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, QualityStore } from '../src/store.js';

export function tmpDb(catalog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcs-'));
  initDb(dir, catalog);
  return dir;
}

export function openStore(dir, opts) {
  return QualityStore.open(dir, opts);
}

export function walEntries(dir) {
  const file = path.join(dir, 'wal.log');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
}

export function committedEntries(dir) {
  const entries = walEntries(dir);
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i].k === 'd' && entries[i + 1]?.k === 'c'
        && entries[i + 1].seq === entries[i].seq && entries[i + 1].hash === entries[i].hash) {
      out.push(entries[i]);
      i += 1;
    }
  }
  return out;
}

export function certFiles(dir) {
  return fs.readdirSync(path.join(dir, 'certs')).filter((f) => f.endsWith('.json'));
}
