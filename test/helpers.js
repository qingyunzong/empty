import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function mkTmpDir(prefix = 'coldchain-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function writeInputs(dir, { readings = [], shipments = [], adjustments = null }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'readings.jsonl'),
    readings.map((r) => JSON.stringify(r)).join('\n') + (readings.length ? '\n' : ''),
  );
  writeFileSync(path.join(dir, 'shipments.json'), JSON.stringify({ shipments }, null, 2));
  if (adjustments !== null) {
    writeFileSync(
      path.join(dir, 'adjustments.jsonl'),
      adjustments.map((a) => JSON.stringify(a)).join('\n') + (adjustments.length ? '\n' : ''),
    );
  }
  return dir;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
