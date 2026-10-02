import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PackStore } from '../src/store.js';

// Deterministic PRNG (mulberry32) for reproducible randomized tests.
export function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evpack-test-'));
}

// Build an in-memory store directly from row objects (no filesystem).
export function memStore(rows, rules = []) {
  const store = new PackStore('.');
  for (const r of rows) {
    store.evidence.set(r.key, { attrs: r.attrs ?? {}, state: r.state ?? 'asserted' });
  }
  store.rules = rules.map((r) => ({ priority: 0, where: [], ...r }));
  store.ruleVersion = rules.length;
  store.rebuildIndexes();
  return store;
}

export function writePack(dir, rows) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'evidence.jsonl'), lines);
}
