import { ArchiveError } from './errors.js';

/**
 * Normalize a slash-segmented archive path: drop empty and '.' segments,
 * resolve '..' against previously seen segments. Case-sensitive.
 * Throws ESCAPE_ROOT when '..' would climb above the archive root.
 */
export function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new ArchiveError('ESCAPE_ROOT', `path escapes archive root: ${JSON.stringify(path)}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

export function splitNormalized(normalized: string): string[] {
  return normalized === '' ? [] : normalized.split('/');
}

/** Normalize `relative` against `base` (both inside the archive); absolute targets normalize from root. */
export function joinNormalized(base: string, relative: string): string {
  if (relative.startsWith('/')) return normalizePath(relative);
  return normalizePath(base === '' ? relative : `${base}/${relative}`);
}

export function parentOf(normalized: string): string {
  const at = normalized.lastIndexOf('/');
  return at < 0 ? '' : normalized.slice(0, at);
}
