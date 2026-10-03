import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);

export function tmpDir(prefix = 'pack-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// files: { 'vision.jsonl': [obj, ...], ... } -> writes one JSON object per line
export function writeInput(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return dir;
}

export function readOutputs(outDir) {
  return {
    'cases.jsonl': fs.readFileSync(path.join(outDir, 'cases.jsonl'), 'utf8'),
    'release.json': fs.readFileSync(path.join(outDir, 'release.json'), 'utf8'),
    'late.log': fs.readFileSync(path.join(outDir, 'late.log'), 'utf8'),
  };
}

export function readCases(outDir) {
  return fs.readFileSync(path.join(outDir, 'cases.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
