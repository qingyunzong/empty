// Independent route matcher: deliberately shares no code with the
// canonicalizer, so tests can cross-check that key-equivalent URLs keep
// identical public routing semantics.

export interface RouteMatch {
  pattern: string;
  patternIndex: number;
  params: Record<string, string>;
}

// Patterns are '/'-separated segments; '{name}' captures one non-empty
// segment, every other segment must match literally. First match wins.
export function matchRoute(patterns: string[], path: string): RouteMatch | null {
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex++) {
    const params = matchPattern(patterns[patternIndex], path);
    if (params !== null) {
      return { pattern: patterns[patternIndex], patternIndex, params };
    }
  }
  return null;
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternSegs = pattern.split('/');
  const pathSegs = path.split('/');
  if (patternSegs.length !== pathSegs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const p = patternSegs[i];
    const s = pathSegs[i];
    if (p.length > 2 && p.startsWith('{') && p.endsWith('}')) {
      if (s.length === 0) return null;
      params[p.slice(1, -1)] = s;
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}
