import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStore } from '../src/store.js';

export function tmpdir(prefix = 'obs-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function freshStore(node, nodes = []) {
  const dir = tmpdir();
  initStore(dir, { node, nodes });
  return dir;
}

export function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}
