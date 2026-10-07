import { lstat, readdir, readlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ContentEvidence, Manifest, ManifestEntry } from './types.js';
import { evidenceEqual, sortEntries } from './manifest.js';

export interface ScanOptions {
  /** Attempts per file before it is flagged unstable (default 3). */
  retries?: number;
  /** Delay between stability retries in ms (default 25). */
  retryDelayMs?: number;
  /**
   * Previous manifest used as a cache. A cached hash is reused only when the
   * cached content evidence exactly matches a fresh lstat of the file.
   */
  cache?: Manifest;
  /** Injectable fs hooks (used by tests to observe/verify hashing). */
  hashDeps?: HashDeps;
}

export interface StatLike {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface HashDeps {
  stat: (path: string) => Promise<StatLike>;
  readFile: (path: string) => Promise<Uint8Array>;
}

const defaultDeps: HashDeps = { stat: lstat, readFile };

function evidenceOf(stat: StatLike): ContentEvidence {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export interface StableHashResult {
  hash: string;
  stable: boolean;
  evidence: ContentEvidence;
}

/**
 * Hash a file while guarding against concurrent modification: lstat before
 * and after the read must yield identical evidence, otherwise the read raced
 * a writer and is retried. After `retries` failed attempts the last hash is
 * returned with stable=false so the caller can flag the entry unstable.
 */
export async function hashFileStable(
  path: string,
  retries: number,
  retryDelayMs: number,
  deps: HashDeps = defaultDeps
): Promise<StableHashResult> {
  let hash = '';
  let evidence: ContentEvidence = { size: 0, mtimeMs: 0, ctimeMs: 0, ino: 0 };
  for (let attempt = 0; attempt < retries; attempt++) {
    const before = evidenceOf(await deps.stat(path));
    const data = await deps.readFile(path);
    const after = evidenceOf(await deps.stat(path));
    hash = sha256Hex(data);
    evidence = after;
    if (evidenceEqual(before, after)) {
      return { hash, stable: true, evidence };
    }
    if (attempt + 1 < retries && retryDelayMs > 0) await sleep(retryDelayMs);
  }
  return { hash, stable: false, evidence };
}

/**
 * Recursively scan `root` into a manifest of relative paths, entry types and
 * content hashes. Symlinks are recorded with their raw target and are never
 * followed. Files that change during the scan are retried a limited number
 * of times and then flagged `unstable`.
 */
export async function scanDirectory(root: string, options: ScanOptions = {}): Promise<Manifest> {
  const retries = options.retries ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 25;
  const hashDeps = options.hashDeps ?? defaultDeps;
  const cacheIndex = new Map<string, ManifestEntry>();
  if (options.cache) {
    for (const entry of options.cache.entries) cacheIndex.set(entry.path, entry);
  }

  const entries: ManifestEntry[] = [];

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(dirAbs);
    } catch {
      return; // directory vanished or is unreadable mid-scan
    }
    for (const name of names) {
      const abs = join(dirAbs, name);
      const rel = dirRel === '' ? name : dirRel + '/' + name;
      let lst;
      try {
        lst = await lstat(abs);
      } catch {
        continue; // entry vanished mid-scan
      }
      if (lst.isSymbolicLink()) {
        let linkTarget = '';
        try {
          linkTarget = await readlink(abs);
        } catch {
          // target disappeared between lstat and readlink
        }
        entries.push({ path: rel, type: 'symlink', linkTarget });
      } else if (lst.isDirectory()) {
        entries.push({ path: rel, type: 'directory' });
        await walk(abs, rel);
      } else if (lst.isFile()) {
        const evidence = evidenceOf(lst);
        const cached = cacheIndex.get(rel);
        if (
          cached &&
          cached.type === 'file' &&
          !cached.unstable &&
          cached.hash !== undefined &&
          cached.evidence !== undefined &&
          evidenceEqual(cached.evidence, evidence)
        ) {
          entries.push({ path: rel, type: 'file', hash: cached.hash, evidence });
        } else {
          const result = await hashFileStable(abs, retries, retryDelayMs, hashDeps);
          const entry: ManifestEntry = {
            path: rel,
            type: 'file',
            hash: result.hash,
            evidence: result.evidence,
          };
          if (!result.stable) entry.unstable = true;
          entries.push(entry);
        }
      } else {
        entries.push({ path: rel, type: 'other' });
      }
    }
  }

  await walk(root, '');
  return {
    version: 1,
    root,
    createdAt: new Date().toISOString(),
    entries: sortEntries(entries),
  };
}
