import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tokenize } from '../src/indexer.js';

export function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'order-store-'));
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent brute-force phrase match over a Map<id, text>.
export function brutePhrase(docs, phrase) {
  const terms = tokenize(phrase);
  if (!terms.length) return [];
  const hits = [];
  for (const [id, text] of docs) {
    const tokens = tokenize(text);
    let matched = false;
    for (let i = 0; i + terms.length <= tokens.length && !matched; i++) {
      matched = terms.every((term, j) => tokens[i + j] === term);
    }
    if (matched) hits.push(id);
  }
  return hits.sort();
}

// Independent brute-force unordered near match: any combination of
// positions, one per distinct term, whose span fits the window.
export function bruteNear(docs, terms, window) {
  const uniq = [...new Set(terms)];
  if (!uniq.length) return [];
  const hits = [];
  for (const [id, text] of docs) {
    const tokens = tokenize(text);
    const positions = uniq.map((term) =>
      tokens.flatMap((token, i) => (token === term ? [i] : [])));
    if (positions.some((list) => list.length === 0)) continue;
    let found = false;
    const walk = (k, acc) => {
      if (found) return;
      if (k === positions.length) {
        found = Math.max(...acc) - Math.min(...acc) + 1 <= window;
        return;
      }
      for (const pos of positions[k]) walk(k + 1, [...acc, pos]);
    };
    walk(0, []);
    if (found) hits.push(id);
  }
  return hits.sort();
}

export function hashResults(results) {
  return createHash('sha256').update(JSON.stringify(results)).digest('hex');
}
