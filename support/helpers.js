import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function makeTempDir(prefix = 'txn-undo-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function genTree(rng, { count = 15, vocab = ['alpha', 'beta', 'gamma', 'delta'], maxTokens = 8 } = {}) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    const id = `n${String(i).padStart(3, '0')}`;
    const parentId = i === 0 ? null : nodes[Math.floor(rng() * i)].id;
    const len = Math.floor(rng() * (maxTokens + 1));
    const reason = Array.from({ length: len }, () => vocab[Math.floor(rng() * vocab.length)]).join(' ');
    nodes.push({ id, parentId, amount: Math.floor(rng() * 50) + 1, reason, state: 'active' });
  }
  return nodes;
}
