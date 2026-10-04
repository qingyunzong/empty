import { canonicalizeUrl, Canonicalization } from './canonicalize.js';

// Memoizes canonicalizations keyed by the EXACT original URL string.
// Two different originals that canonicalize identically (e.g. duplicate
// parameters in a different order) never share an entry, so each result
// keeps its own original-parameter mapping.
export class CanonicalizationCache {
  private readonly map = new Map<string, Canonicalization>();
  private readonly canonicalize: (raw: string) => Canonicalization;

  constructor(canonicalize: (raw: string) => Canonicalization = canonicalizeUrl) {
    this.canonicalize = canonicalize;
  }

  get(raw: string): Canonicalization {
    let c = this.map.get(raw);
    if (c === undefined) {
      c = this.canonicalize(raw);
      this.map.set(raw, c);
    }
    return c;
  }

  has(raw: string): boolean {
    return this.map.has(raw);
  }

  get size(): number {
    return this.map.size;
  }
}
