import type { ContentEvidence, Manifest, ManifestEntry } from './types.js';

export function evidenceEqual(a: ContentEvidence, b: ContentEvidence): boolean {
  return (
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino
  );
}

export function sortEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

function normalizeEntry(entry: ManifestEntry): ManifestEntry {
  const out: ManifestEntry = { path: entry.path, type: entry.type };
  if (entry.hash !== undefined) out.hash = entry.hash;
  if (entry.unstable) out.unstable = true;
  if (entry.evidence !== undefined) {
    out.evidence = {
      size: entry.evidence.size,
      mtimeMs: entry.evidence.mtimeMs,
      ctimeMs: entry.evidence.ctimeMs,
      ino: entry.evidence.ino,
    };
  }
  if (entry.linkTarget !== undefined) out.linkTarget = entry.linkTarget;
  return out;
}

/**
 * Canonical comparable form: volatile metadata (root, createdAt) is dropped,
 * entries are sorted and emitted with a stable key order.
 */
export function canonicalize(manifest: Manifest): { version: 1; entries: ManifestEntry[] } {
  return { version: manifest.version, entries: sortEntries(manifest.entries).map(normalizeEntry) };
}

export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(canonicalize(manifest), null, 2) + '\n';
}

export interface EntryChange {
  path: string;
  before: ManifestEntry;
  after: ManifestEntry;
  reasons: string[];
}

export interface ManifestDiff {
  equal: boolean;
  added: ManifestEntry[];
  removed: ManifestEntry[];
  changed: EntryChange[];
}

/**
 * Content-identity comparison of two entries. Evidence (mtime/ctime) is
 * deliberately ignored: it is cache bookkeeping, not content identity.
 */
export function compareEntries(a: ManifestEntry, b: ManifestEntry): string[] {
  const reasons: string[] = [];
  if (a.type !== b.type) reasons.push(`type ${a.type} -> ${b.type}`);
  if (a.hash !== b.hash) reasons.push('hash changed');
  if (Boolean(a.unstable) !== Boolean(b.unstable)) reasons.push('stability changed');
  if (a.linkTarget !== b.linkTarget) reasons.push('link target changed');
  return reasons;
}

export function compareManifests(a: Manifest, b: Manifest): ManifestDiff {
  const byPathA = new Map(a.entries.map((e) => [e.path, e]));
  const byPathB = new Map(b.entries.map((e) => [e.path, e]));
  const added: ManifestEntry[] = [];
  const removed: ManifestEntry[] = [];
  const changed: EntryChange[] = [];
  for (const [path, entryB] of byPathB) {
    const entryA = byPathA.get(path);
    if (!entryA) {
      added.push(entryB);
    } else {
      const reasons = compareEntries(entryA, entryB);
      if (reasons.length > 0) changed.push({ path, before: entryA, after: entryB, reasons });
    }
  }
  for (const [path, entryA] of byPathA) {
    if (!byPathB.has(path)) removed.push(entryA);
  }
  return {
    equal: added.length === 0 && removed.length === 0 && changed.length === 0,
    added: sortEntries(added),
    removed: sortEntries(removed),
    changed: changed.sort((x, y) => (x.path < y.path ? -1 : 1)),
  };
}
