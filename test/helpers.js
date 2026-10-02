import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bns-'));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
