import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Manifest } from './types.js';

export function isManifest(value: unknown): value is Manifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; entries?: unknown };
  return candidate.version === 1 && Array.isArray(candidate.entries);
}

/** Load a previously saved manifest to serve as a scan cache. */
export async function loadCache(file: string): Promise<Manifest | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isManifest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCache(file: string, manifest: Manifest): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}
