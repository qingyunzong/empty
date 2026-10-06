import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArchiveError, buildIndex } from '../src/index.js';
import type { ArchiveEntry, EntryType, ResolvedEntry } from '../src/index.js';
import { slowBuild } from '../src/slowModel.js';

// Deterministic PRNG (mulberry32) so failures reproduce.
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['a', 'b', 'c', 'A', 'B', '.', '..', '', 'x', 'y', 'dir', 'f', 'lnk'];

function randomPath(rnd: () => number, maxSegments: number): string {
  const n = Math.floor(rnd() * (maxSegments + 1));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(SEGMENTS[Math.floor(rnd() * SEGMENTS.length)]!);
  const path = parts.join('/');
  return rnd() < 0.2 ? `/${path}` : path;
}

function randomEntries(rnd: () => number): ArchiveEntry[] {
  const count = Math.floor(rnd() * 13);
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rnd();
    const type: EntryType = roll < 0.45 ? 'file' : roll < 0.55 ? 'dir' : 'symlink';
    const entry: ArchiveEntry = { path: randomPath(rnd, 4), type };
    if (type === 'symlink') {
      // Bias targets towards earlier entries so symlink chains and cycles occur often.
      const earlierSymlinks = entries.filter((e) => e.type === 'symlink');
      const roll = rnd();
      if (earlierSymlinks.length > 0 && roll < 0.45) {
        entry.target = earlierSymlinks[Math.floor(rnd() * earlierSymlinks.length)]!.path;
      } else if (entries.length > 0 && roll < 0.75) {
        entry.target = entries[Math.floor(rnd() * entries.length)]!.path;
      } else {
        entry.target = randomPath(rnd, 3);
      }
    }
    entries.push(entry);
  }
  return entries;
}

type Outcome =
  | { ok: true; value: ResolvedEntry }
  | { ok: false; code: string; chain: string[] | null };

function captureResolve(fn: () => ResolvedEntry): Outcome {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    assert.ok(err instanceof ArchiveError, `unexpected error type: ${String(err)}`);
    return { ok: false, code: err.code, chain: err.chain ?? null };
  }
}

function captureBuild<T>(fn: () => T): { ok: true; value: T } | { ok: false; code: string } {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    assert.ok(err instanceof ArchiveError, `unexpected error type: ${String(err)}`);
    return { ok: false, code: err.code };
  }
}

test('fast index and recursive slow model agree on random archives', () => {
  const rnd = mulberry32(0xa2c4 ^ 0x5eed);
  const tallies = { built: 0, rejected: 0, resolved: 0, cycles: 0 };
  for (let round = 0; round < 8000; round++) {
    const entries = randomEntries(rnd);
    const fast = captureBuild(() => buildIndex(entries));
    const slow = captureBuild(() => slowBuild(entries));
    assert.equal(
      fast.ok,
      slow.ok,
      `build disagreement for ${JSON.stringify(entries)}: fast=${JSON.stringify(fast)} slow=${JSON.stringify(slow)}`,
    );
    if (!fast.ok && !slow.ok) {
      assert.equal(
        fast.code,
        slow.code,
        `error-code disagreement for ${JSON.stringify(entries)}: fast=${fast.code} slow=${slow.code}`,
      );
      tallies.rejected++;
      continue;
    }
    if (!fast.ok || !slow.ok) continue; // unreachable, keeps the type checker happy
    tallies.built++;
    const fastIndex = fast.value;
    const slowIndex = slow.value;
    const lookups: string[] = [];
    for (const entry of entries) lookups.push(entry.path);
    for (let i = 0; i < 12; i++) lookups.push(randomPath(rnd, 5));
    for (const lookup of lookups) {
      const expected = captureResolve(() => slowIndex.resolve(lookup));
      const actual = captureResolve(() => fastIndex.resolve(lookup));
      assert.equal(
        actual.ok,
        expected.ok,
        `resolve(${JSON.stringify(lookup)}) disagreement in ${JSON.stringify(entries)}`,
      );
      if (actual.ok && expected.ok) {
        tallies.resolved++;
        assert.equal(actual.value.path, expected.value.path, `path mismatch resolving ${JSON.stringify(lookup)}`);
        assert.equal(actual.value.type, expected.value.type, `type mismatch resolving ${JSON.stringify(lookup)}`);
      } else if (!actual.ok && !expected.ok) {
        if (actual.code === 'SYMLINK_CYCLE') tallies.cycles++;
        assert.equal(actual.code, expected.code, `error mismatch resolving ${JSON.stringify(lookup)}`);
        assert.deepEqual(actual.chain, expected.chain, `cycle-chain mismatch resolving ${JSON.stringify(lookup)}`);
      }
    }
  }
  // The generator must keep exercising every interesting path.
  assert.ok(tallies.built > 1000, `too few valid archives: ${tallies.built}`);
  assert.ok(tallies.rejected > 1000, `too few rejected archives: ${tallies.rejected}`);
  assert.ok(tallies.resolved > 5000, `too few resolutions: ${tallies.resolved}`);
  assert.ok(tallies.cycles > 50, `too few symlink cycles: ${tallies.cycles}`);
});
