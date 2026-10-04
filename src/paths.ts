/**
 * Path handling shared by layers and the resolver.
 * Paths are POSIX-style: '/' separates segments, '\' is accepted as an
 * alias, '.' and '..' are resolved lexically, and '..' at the root stays
 * at the root. The root itself is represented by zero segments.
 */
export function normalizePath(input: string): string[] {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('path must be a non-empty string');
  }
  const segments: string[] = [];
  for (const raw of input.replace(/\\/g, '/').split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      segments.pop();
      continue;
    }
    segments.push(raw);
  }
  return segments;
}

export function joinPath(base: string, name: string): string {
  const trimmed = base.length > 1 && base.endsWith('/') ? base.slice(0, -1) : base;
  return trimmed === '/' ? `/${name}` : `${trimmed}/${name}`;
}

/**
 * Canonical lookup key for a segment list. Case rules are an input to the
 * resolver: case-sensitive mode keeps segments verbatim, case-insensitive
 * mode folds case while layers still keep the original display names.
 */
export function keyFor(segments: readonly string[], caseSensitive: boolean): string {
  const joined = segments.join('/');
  return caseSensitive ? joined : joined.toLowerCase();
}
