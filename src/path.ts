/** Path helpers. All paths are absolute, '/'-separated, root is '/'. */

export function normalizePath(input: string): string {
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return '/' + parts.join('/');
}

export function parentPath(path: string): string | undefined {
  if (path === '/') return undefined;
  const index = path.lastIndexOf('/');
  return index === 0 ? '/' : path.slice(0, index);
}

/** Strict ancestors of `path`, nearest first. */
export function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let current = parentPath(path);
  while (current !== undefined) {
    out.push(current);
    current = parentPath(current);
  }
  return out;
}

export function joinPath(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
