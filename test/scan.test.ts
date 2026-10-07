import { test } from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { scanDirectory } from '../src/scanner.js';
import { serializeManifest } from '../src/manifest.js';

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'diridx-scan-'));
  await writeFile(join(root, 'a.txt'), 'hello');
  await mkdir(join(root, 'sub'));
  await writeFile(join(root, 'sub', 'b.txt'), 'world');
  await symlink('a.txt', join(root, 'link-rel'));
  await symlink(join(root, 'a.txt'), join(root, 'link-abs'));
  await symlink('sub', join(root, 'link-dir'));
  await symlink('/etc/hostname', join(root, 'link-outside'));
  return root;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('scan records relative paths, types and hashes; symlinks are not followed', async () => {
  const root = await makeFixture();
  try {
    const manifest = await scanDirectory(root);
    const paths = manifest.entries.map((entry) => entry.path);
    deepEqual(paths, [...paths].sort(), 'entries are sorted by relative path');

    const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    equal(byPath.get('a.txt')?.type, 'file');
    equal(byPath.get('a.txt')?.hash, sha256('hello'));
    equal(byPath.get('sub')?.type, 'directory');
    equal(byPath.get('sub/b.txt')?.hash, sha256('world'));

    const linkRel = byPath.get('link-rel');
    equal(linkRel?.type, 'symlink');
    equal(linkRel?.linkTarget, 'a.txt');
    equal(linkRel?.hash, undefined, 'symlink content is not hashed');

    const linkAbs = byPath.get('link-abs');
    equal(linkAbs?.type, 'symlink');
    equal(linkAbs?.linkTarget, join(root, 'a.txt'));

    equal(byPath.get('link-dir')?.type, 'symlink');
    ok(!byPath.has('link-dir/b.txt'), 'symlinked directory is not traversed');

    const outside = byPath.get('link-outside');
    equal(outside?.type, 'symlink');
    equal(outside?.linkTarget, '/etc/hostname');
    equal(outside?.hash, undefined, 'target outside the root is never read');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('serialized manifest is deterministic across repeated scans', async () => {
  const root = await makeFixture();
  try {
    const first = await scanDirectory(root);
    const second = await scanDirectory(root);
    equal(serializeManifest(first), serializeManifest(second));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
