/** Split a path into raw segments (keeps "." and "..", drops nothing). */
export function splitPath(path: string): string[] {
  return path.split("/");
}

/**
 * Resolve "."/".." segments against a base component stack.
 * ".." at the bottom of the stack is clamped (cannot go below it).
 */
export function normalizeSegments(base: readonly string[], segments: readonly string[]): string[] {
  const out = [...base];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** True when `prefix` is a leading component-wise prefix of `path`. */
export function isPrefixOf(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false;
  }
  return true;
}

export function displayPath(stack: readonly string[]): string {
  return "/" + stack.join("/");
}
