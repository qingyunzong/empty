/**
 * Recursive slow model: a deliberately naive reference implementation of
 * src/index.ts, written in a direct recursive style so it can cross-check
 * the fast implementation in the differential tests.
 */

import {
  ArchiveEntry,
  DuplicatePathError,
  IndexedEntry,
  InvalidEntryError,
  PathEscapeError,
  ResolveResult,
} from './index';

/** Recursive dot-segment elimination over the '/'-segmented path. */
export function slowNormalize(path: string): string {
  const step = (segments: string[], stack: string[]): string[] => {
    if (segments.length === 0) return stack;
    const head = segments[0] as string;
    const tail = segments.slice(1);
    if (head === '' || head === '.') return step(tail, stack);
    if (head === '..') {
      if (stack.length === 0) throw new PathEscapeError(path);
      return step(tail, stack.slice(0, -1));
    }
    return step(tail, [...stack, head]);
  };
  return step(path.split('/'), []).join('/');
}

function slowParentOf(normalizedPath: string): string {
  const slash = normalizedPath.lastIndexOf('/');
  return slash === -1 ? '' : normalizedPath.slice(0, slash);
}

/** Recursive normalization of a link target against its containing directory. */
export function slowNormalizeTarget(linkPath: string, target: string): string {
  if (target.startsWith('/')) return slowNormalize(target);
  const parent = slowParentOf(linkPath);
  return slowNormalize(parent === '' ? target : `${parent}/${target}`);
}

/** Recursive fold over the entries; any error rejects the whole archive. */
export function slowBuildIndex(entries: ArchiveEntry[]): Map<string, IndexedEntry> {
  const go = (rest: ArchiveEntry[], acc: Map<string, IndexedEntry>): Map<string, IndexedEntry> => {
    if (rest.length === 0) return acc;
    const entry = rest[0] as ArchiveEntry;
    const path = slowNormalize(entry.path);
    if (acc.has(path)) throw new DuplicatePathError(path);
    if (entry.type === 'symlink') {
      if (entry.target === undefined) {
        throw new InvalidEntryError(`symlink without target: ${JSON.stringify(entry.path)}`);
      }
      acc.set(path, { type: 'symlink', path, target: slowNormalizeTarget(path, entry.target) });
    } else {
      acc.set(path, { type: entry.type, path });
    }
    return go(rest.slice(1), acc);
  };
  return go(entries, new Map());
}

/** Recursive symlink expansion; a cycle yields the shortest repeated chain. */
export function slowResolve(
  index: Map<string, IndexedEntry>,
  path: string,
): ResolveResult {
  const visit = (current: string, chain: string[]): ResolveResult => {
    const entry = index.get(current);
    if (entry === undefined || entry.type !== 'symlink') {
      return { ok: true, path: current };
    }
    const at = chain.indexOf(current);
    if (at !== -1) return { ok: false, cycle: chain.slice(at) };
    return visit(entry.target as string, [...chain, current]);
  };
  return visit(slowNormalize(path), []);
}
