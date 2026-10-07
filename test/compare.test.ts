import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { compareManifests, serializeManifest } from '../src/manifest.js';
import type { Manifest, ManifestEntry } from '../src/types.js';

function manifest(entries: ManifestEntry[]): Manifest {
  return { version: 1, root: '/fixture', createdAt: '2026-01-01T00:00:00.000Z', entries };
}

test('compareManifests reports added, removed and changed entries', () => {
  const before = manifest([
    { path: 'keep.txt', type: 'file', hash: 'h1' },
    { path: 'gone.txt', type: 'file', hash: 'h2' },
    { path: 'mod.txt', type: 'file', hash: 'h3' },
  ]);
  const after = manifest([
    { path: 'keep.txt', type: 'file', hash: 'h1' },
    { path: 'mod.txt', type: 'file', hash: 'h3-new' },
    { path: 'new.txt', type: 'file', hash: 'h4' },
  ]);
  const diff = compareManifests(before, after);
  ok(!diff.equal);
  deepEqual(diff.added.map((entry) => entry.path), ['new.txt']);
  deepEqual(diff.removed.map((entry) => entry.path), ['gone.txt']);
  deepEqual(diff.changed.map((change) => change.path), ['mod.txt']);
  deepEqual(diff.changed[0].reasons, ['hash changed']);
});

test('manifests with identical content compare equal regardless of order and metadata', () => {
  const a = manifest([
    { path: 'b.txt', type: 'file', hash: 'x' },
    { path: 'a.txt', type: 'file', hash: 'y' },
  ]);
  const b: Manifest = {
    ...manifest([
      { path: 'a.txt', type: 'file', hash: 'y' },
      { path: 'b.txt', type: 'file', hash: 'x' },
    ]),
    root: '/elsewhere',
    createdAt: '2026-02-02T00:00:00.000Z',
  };
  ok(compareManifests(a, b).equal);
  equal(serializeManifest(a), serializeManifest(b), 'canonical serialization is comparable');
});

test('type changes and symlink retargeting are detected', () => {
  const before = manifest([
    { path: 'p', type: 'file', hash: 'h' },
    { path: 'l', type: 'symlink', linkTarget: 't1' },
  ]);
  const after = manifest([
    { path: 'p', type: 'symlink', linkTarget: 't1' },
    { path: 'l', type: 'symlink', linkTarget: 't2' },
  ]);
  const diff = compareManifests(before, after);
  ok(!diff.equal);
  deepEqual(diff.changed.map((change) => change.path), ['l', 'p']);
});

test('touching mtime without changing content still compares equal', () => {
  const before = manifest([
    { path: 'f', type: 'file', hash: 'h', evidence: { size: 1, mtimeMs: 1, ctimeMs: 1, ino: 7 } },
  ]);
  const after = manifest([
    { path: 'f', type: 'file', hash: 'h', evidence: { size: 1, mtimeMs: 2, ctimeMs: 2, ino: 7 } },
  ]);
  ok(compareManifests(before, after).equal, 'evidence is cache metadata, not content identity');
});
