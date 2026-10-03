import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fee-settlement-'));
}

export function writeNdjson(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function appendNdjson(file, rows) {
  fs.appendFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// Deterministic PRNG (mulberry32) so fixtures are reproducible.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
