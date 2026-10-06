import { ArchiveError } from './errors.js';
import type { ArchiveEntry, ResolvedEntry } from './index.js';

/**
 * Recursive reference implementation ("slow model") used to verify the
 * optimized index. It favors obvious correctness over speed: normalization
 * is a recursion over segments with an explicit stack, lookups are linear
 * scans, and symlink expansion re-normalizes the whole path at every step.
 */

export function slowNormalize(path: string): string {
  return walk(path.split('/'), []);
}

function walk(segments: string[], stack: string[]): string {
  if (segments.length === 0) return stack.join('/');
  const [head, ...rest] = segments as [string, ...string[]];
  if (head === '' || head === '.') return walk(rest, stack);
  if (head === '..') {
    if (stack.length === 0) {
      throw new ArchiveError('ESCAPE_ROOT', `path escapes archive root`);
    }
    return walk(rest, stack.slice(0, -1));
  }
  return walk(rest, [...stack, head]);
}

function parentOf(normalized: string): string {
  const at = normalized.lastIndexOf('/');
  return at < 0 ? '' : normalized.slice(0, at);
}

interface Record {
  normalized: string;
  entry: ArchiveEntry;
  target: string | null;
}

export class SlowIndex {
  private readonly records: Record[] = [];

  constructor(entries: ArchiveEntry[]) {
    for (const entry of entries) {
      const normalized = slowNormalize(entry.path);
      if (normalized === '') {
        throw new ArchiveError('EMPTY_PATH', 'entry path normalizes to the archive root');
      }
      if (this.records.some((r) => r.normalized === normalized)) {
        throw new ArchiveError('DUPLICATE_PATH', `duplicate normalized path: ${normalized}`);
      }
      // Ancestors of the new entry must be directories or absent.
      this.checkAncestors(normalized, normalized);
      // A non-directory must not sit above already-seen entries.
      if (entry.type !== 'dir' && this.records.some((r) => r.normalized.startsWith(`${normalized}/`))) {
        throw new ArchiveError('TYPE_CONFLICT', `non-directory entry ${normalized} already has children`);
      }
      let target: string | null = null;
      if (entry.type === 'symlink') {
        if (entry.target === undefined) {
          throw new ArchiveError('MISSING_TARGET', `symlink ${normalized} has no target`);
        }
        target = this.normalizeTarget(normalized, entry.target);
      }
      this.records.push({ normalized, entry, target });
    }
  }

  private checkAncestors(normalized: string, original: string): void {
    const parent = parentOf(normalized);
    if (parent === normalized) return;
    if (parent !== '') {
      const record = this.records.find((r) => r.normalized === parent);
      if (record !== undefined && record.entry.type !== 'dir') {
        throw new ArchiveError('TYPE_CONFLICT', `entry ${original} sits under non-directory ${parent}`);
      }
      this.checkAncestors(parent, original);
    }
  }

  private normalizeTarget(symlinkPath: string, target: string): string {
    if (target.startsWith('/')) return slowNormalize(target);
    const parent = parentOf(symlinkPath);
    return slowNormalize(parent === '' ? target : `${parent}/${target}`);
  }

  resolve(path: string, seen: string[] = []): ResolvedEntry {
    const normalized = slowNormalize(path);
    const segments = normalized === '' ? [] : normalized.split('/');
    for (let i = 1; i <= segments.length; i++) {
      const prefix = segments.slice(0, i).join('/');
      const record = this.records.find((r) => r.normalized === prefix);
      if (record !== undefined && record.entry.type === 'symlink' && record.target !== null) {
        const at = seen.indexOf(prefix);
        if (at >= 0) {
          const cycle = seen.slice(at);
          throw new ArchiveError('SYMLINK_CYCLE', `symlink cycle: ${[...cycle, prefix].join(' -> ')}`, cycle);
        }
        const rest = segments.slice(i).join('/');
        const next = rest === '' ? record.target : record.target === '' ? rest : `${record.target}/${rest}`;
        return this.resolve(next, [...seen, prefix]);
      }
    }
    const record = this.records.find((r) => r.normalized === normalized);
    if (record !== undefined) {
      return { path: normalized, type: record.entry.type, entry: record.entry };
    }
    if (normalized === '') return { path: '', type: 'dir', entry: null };
    if (this.records.some((r) => r.normalized.startsWith(`${normalized}/`))) {
      return { path: normalized, type: 'dir', entry: null };
    }
    throw new ArchiveError('NOT_FOUND', `no entry at ${normalized}`);
  }
}

export function slowBuild(entries: ArchiveEntry[]): SlowIndex {
  return new SlowIndex(entries);
}
