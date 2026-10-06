import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ArchiveEntry,
  buildIndex,
  DuplicatePathError,
  IndexedEntry,
  InvalidEntryError,
  PathEscapeError,
  ResolveResult,
} from '../src/index';
import { slowBuildIndex, slowResolve } from '../src/slow';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['', '.', '..', 'a', 'b', 'c', 'A', 'B', 'x.y', 'dir'];

function randomPath(rand: () => number): string {
  const count = Math.floor(rand() * 5);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(SEGMENTS[Math.floor(rand() * SEGMENTS.length)] as string);
  }
  let path = parts.join('/');
  if (rand() < 0.15) path = `/${path}`;
  if (rand() < 0.15) path = `${path}/`;
  return path;
}

function randomEntries(rand: () => number): ArchiveEntry[] {
  const count = Math.floor(rand() * 9);
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const path = randomPath(rand);
    const roll = rand();
    if (roll < 0.35) {
      entries.push({ path, type: 'symlink', target: randomPath(rand) });
    } else if (roll < 0.5) {
      entries.push({ path, type: 'directory' });
    } else {
      entries.push({ path, type: 'file' });
    }
  }
  // Point half of the links at other entries to encourage chains and cycles.
  for (const entry of entries) {
    if (entry.type === 'symlink' && entries.length > 0 && rand() < 0.5) {
      const other = entries[Math.floor(rand() * entries.length)] as ArchiveEntry;
      (entry as { target?: string }).target = other.path;
    }
  }
  return entries;
}

function errorKey(err: unknown): string {
  if (err instanceof PathEscapeError) return `PathEscapeError:${err.path}`;
  if (err instanceof DuplicatePathError) {
    return `DuplicatePathError:${err.normalizedPath}`;
  }
  if (err instanceof InvalidEntryError) return `InvalidEntryError:${err.message}`;
  return `other:${String(err)}`;
}

interface Outcome {
  error?: string;
  entries?: IndexedEntry[];
  resolves?: ResolveResult[];
}

const byPath = (a: IndexedEntry, b: IndexedEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function runFast(entries: ArchiveEntry[], queries: string[]): Outcome {
  try {
    const index = buildIndex(entries);
    return {
      entries: [...index.entries()].sort(byPath),
      resolves: queries.map((q) => index.resolve(q)),
    };
  } catch (err) {
    return { error: errorKey(err) };
  }
}

function runSlow(entries: ArchiveEntry[], queries: string[]): Outcome {
  try {
    const index = slowBuildIndex(entries);
    return {
      entries: [...index.values()].sort(byPath),
      resolves: queries.map((q) => slowResolve(index, q)),
    };
  } catch (err) {
    return { error: errorKey(err) };
  }
}

test('fast implementation matches the recursive slow model', () => {
  const coverage = { escapes: 0, duplicates: 0, invalid: 0, cycles: 0, ok: 0 };
  for (let seed = 1; seed <= 2000; seed += 1) {
    const rand = mulberry32(seed);
    const entries = randomEntries(rand);
    const queries = [
      ...entries.map((e) => e.path),
      randomPath(rand),
      randomPath(rand),
      randomPath(rand),
    ];
    const fast = runFast(entries, queries);
    const slow = runSlow(entries, queries);
    assert.deepEqual(fast, slow, `seed ${seed}: ${JSON.stringify(entries)}`);
    if (fast.error !== undefined) {
      if (fast.error.startsWith('PathEscapeError')) coverage.escapes += 1;
      else if (fast.error.startsWith('DuplicatePathError')) coverage.duplicates += 1;
      else coverage.invalid += 1;
    } else {
      coverage.ok += 1;
      const cycles = (fast.resolves as ResolveResult[]).filter((r) => !r.ok);
      if (cycles.length > 0) coverage.cycles += 1;
    }
  }
  // The generator must actually exercise every interesting path.
  assert.ok(coverage.escapes > 0, `no escapes covered: ${JSON.stringify(coverage)}`);
  assert.ok(coverage.duplicates > 0, `no duplicates covered: ${JSON.stringify(coverage)}`);
  assert.ok(coverage.cycles > 0, `no cycles covered: ${JSON.stringify(coverage)}`);
  assert.ok(coverage.ok > 0, `no successful archives: ${JSON.stringify(coverage)}`);
});
