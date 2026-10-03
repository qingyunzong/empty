import { open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { MANIFEST_FILE, fsyncDir } from './chain.js';

export async function snapshot(chain) {
  const head = chain.head;
  if (!head) throw new Error('cannot snapshot an empty chain');
  const manifest = {
    version: 1,
    seq: head.seq,
    headHash: head.hash,
    merkleRoot: chain.merkleRoot,
    eventCount: chain.events.length,
    ts: new Date().toISOString(),
  };
  const manifestPath = path.join(chain.dir, MANIFEST_FILE);
  const tmpPath = manifestPath + '.tmp';
  const fh = await open(tmpPath, 'w');
  try {
    await fh.write(JSON.stringify(manifest, null, 2) + '\n');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmpPath, manifestPath);
  await fsyncDir(chain.dir);
  chain.manifest = manifest;
  return manifest;
}

export async function loadManifest(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}
