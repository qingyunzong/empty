// Independent reference implementations used to cross-check the library.
import { tokenize } from '../src/index.js';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Reference phrase scan: slide over tokens, compare term by term.
export function refPhraseHits(text, terms) {
  const tokens = tokenize(text);
  const q = terms.map((t) => t.toLowerCase());
  const hits = [];
  for (let s = 0; s + q.length <= tokens.length; s++) {
    let ok = true;
    for (let i = 0; i < q.length; i++) {
      if (tokens[s + i] !== q[i]) { ok = false; break; }
    }
    if (ok) hits.push({ start: s, end: s + q.length - 1 });
  }
  return hits;
}

// Reference unordered-near: enumerate ALL unordered windows = every
// combination of one position per term; window = [min, max]; a window
// matches when (max - min) - (n - 1) <= slop. Dedupe by span.
export function refNearWindows(text, terms, slop) {
  const tokens = tokenize(text);
  const q = terms.map((t) => t.toLowerCase());
  const posLists = q.map((t) => {
    const list = [];
    tokens.forEach((tok, i) => { if (tok === t) list.push(i); });
    return list;
  });
  if (posLists.some((l) => l.length === 0)) return [];
  const n = q.length;
  const out = new Map();
  const combo = new Array(n);
  const dfs = (i) => {
    if (i === n) {
      const start = Math.min(...combo);
      const end = Math.max(...combo);
      if (end - start - (n - 1) <= slop && !out.has(start + ':' + end)) {
        const termSet = new Set(q);
        const positions = [];
        for (let p = start; p <= end; p++) if (termSet.has(tokens[p])) positions.push(p);
        out.set(start + ':' + end, { start, end, distance: end - start, positions });
      }
      return;
    }
    for (const p of posLists[i]) { combo[i] = p; dfs(i + 1); }
  };
  dfs(0);
  return [...out.values()];
}
