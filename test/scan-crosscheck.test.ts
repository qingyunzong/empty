import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LayeredResolver, type Entry } from '../src/index.js';

/**
 * Cross-check: the merged view is recomputed here by an independent
 * layer-by-layer scan (top to bottom, tracking shadowed prefixes) and
 * compared against what the resolver exposes through readdir()+readFile().
 */

interface ViewEntry {
  kind: 'file' | 'dir';
  content?: string;
}

function foldedKey(segments: readonly string[], caseSensitive: boolean): string {
  const joined = segments.join('/');
  return caseSensitive ? joined : joined.toLowerCase();
}

/** Reference model: scan layers one by one and apply tombstone/shadow rules. */
function referenceView(resolver: LayeredResolver): Map<string, ViewEntry> {
  const cs = resolver.caseSensitive;
  const visible = new Map<string, Entry>(); // folded key -> winning entry
  const shadowedPrefixes: string[] = [];
  for (const layer of resolver.layers) {
    const newShadows: string[] = [];
    for (const stored of layer.values()) {
      const key = foldedKey(stored.segments, cs);
      if (shadowedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
      if (!visible.has(key)) visible.set(key, stored.entry);
      const entry = stored.entry;
      if (entry.kind !== 'dir' || entry.opaque) newShadows.push(`${key}/`);
    }
    shadowedPrefixes.push(...newShadows);
  }
  const view = new Map<string, ViewEntry>();
  for (const [key, entry] of visible) {
    if (entry.kind === 'tombstone') continue;
    if (entry.kind === 'file') view.set(key, { kind: 'file', content: entry.content });
    else view.set(key, { kind: 'dir' });
  }
  return view;
}

/** Actual view: walk the resolver only through readdir/stat/readFile. */
function actualView(resolver: LayeredResolver): Map<string, ViewEntry> {
  const cs = resolver.caseSensitive;
  const view = new Map<string, ViewEntry>();
  const visit = (dir: string): void => {
    for (const name of resolver.readdir(dir)) {
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      const stat = resolver.stat(path);
      assert.ok(stat, `listed name must resolve: ${path}`);
      const key = foldedKey(path.split('/').filter(Boolean), cs);
      if (stat.kind === 'dir') {
        view.set(key, { kind: 'dir' });
        visit(path);
      } else {
        view.set(key, { kind: 'file', content: resolver.readFile(path) });
      }
    }
  };
  visit('/');
  return view;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['app', 'App', 'config', 'Config', 'db.json', 'DB.JSON', 'x.txt', 'y.txt'];

function randomPath(rand: () => number): string {
  const depth = 1 + Math.floor(rand() * 3);
  const parts: string[] = [];
  for (let i = 0; i < depth; i++) {
    parts.push(NAMES[Math.floor(rand() * NAMES.length)] as string);
  }
  return `/${parts.join('/')}`;
}

function runMixedTombstoneFuzz(caseSensitive: boolean, seed: number, ops: number): void {
  const resolver = new LayeredResolver({ caseSensitive });
  const layers = [resolver.addLayer('L0'), resolver.addLayer('L1'), resolver.addLayer('L2')];
  const rand = mulberry32(seed);
  for (let step = 0; step < ops; step++) {
    const layer = layers[Math.floor(rand() * layers.length)];
    if (!layer) continue;
    const path = randomPath(rand);
    const roll = rand();
    try {
      if (roll < 0.55) layer.writeFile(path, `${layer.name}#${step}`);
      else if (roll < 0.75) layer.mkdir(path);
      else layer.remove(path);
    } catch {
      // ENOTDIR/EISDIR/EEXIST conflicts are legal outcomes of random ops.
    }
    if (step % 20 === 19) {
      assert.deepEqual(actualView(resolver), referenceView(resolver), `mismatch at op ${step}`);
    }
  }
  assert.deepEqual(actualView(resolver), referenceView(resolver), 'final view mismatch');
}

describe('layer-by-layer scan cross-check with mixed tombstones', () => {
  it('hand-built mixed tombstone fixture matches the reference scan', () => {
    const resolver = new LayeredResolver({ caseSensitive: true });
    const top = resolver.addLayer('top');
    const mid = resolver.addLayer('mid');
    const bottom = resolver.addLayer('bottom');
    bottom.writeFile('/a/b/c.txt', 'c');
    bottom.writeFile('/a/b/d.txt', 'd');
    bottom.writeFile('/a/e.txt', 'e');
    bottom.writeFile('/f/g.txt', 'g');
    mid.remove('/a/b');
    mid.writeFile('/a/b/m.txt', 'm');
    mid.remove('/f');
    top.writeFile('/a/b/t.txt', 't');
    top.remove('/a/e.txt');
    assert.deepEqual(actualView(resolver), referenceView(resolver));
    assert.deepEqual(
      [...actualView(resolver).keys()].sort(),
      ['a', 'a/b', 'a/b/m.txt', 'a/b/t.txt'],
    );
  });

  it('randomized mixed tombstones, case-sensitive', () => {
    runMixedTombstoneFuzz(true, 12345, 300);
  });

  it('randomized mixed tombstones, case-insensitive', () => {
    runMixedTombstoneFuzz(false, 67890, 300);
  });

  it('snapshots taken mid-fuzz stay frozen at their own view', () => {
    const resolver = new LayeredResolver({ caseSensitive: false });
    const layers = [resolver.addLayer('L0'), resolver.addLayer('L1')];
    const rand = mulberry32(4242);
    const snaps: Array<{ snap: LayeredResolver; expected: Map<string, ViewEntry> }> = [];
    for (let step = 0; step < 120; step++) {
      const layer = layers[Math.floor(rand() * layers.length)];
      if (!layer) continue;
      const path = randomPath(rand);
      try {
        if (rand() < 0.7) layer.writeFile(path, `v${step}`);
        else layer.remove(path);
      } catch {
        // legal conflicts
      }
      if (step % 30 === 29) {
        const snap = resolver.snapshot();
        snaps.push({ snap, expected: referenceView(resolver) });
      }
    }
    for (const [index, { snap, expected }] of snaps.entries()) {
      assert.deepEqual(actualView(snap), expected, `snapshot ${index} drifted`);
    }
  });
});
