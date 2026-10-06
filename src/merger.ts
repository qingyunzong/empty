/** A single search result. `withdrawn` marks a retraction of that version. */
export interface SearchHit {
  id: string;
  score: number;
  version: number;
  withdrawn?: boolean;
}

export interface SearchPage {
  hits: SearchHit[];
}

/** Score descending, then id ascending. */
export function compareHits(a: SearchHit, b: SearchHit): number {
  if (a.score !== b.score) return b.score - a.score;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merges hits from any number of asynchronously arriving pages.
 *
 * - Same id: the hit with the higher `version` wins; older versions are dropped.
 * - A withdrawn hit leaves a tombstone: the live entry is removed and any
 *   later arrival of the same id with version <= tombstone is ignored.
 * - A version newer than the tombstone is still accepted.
 */
export class ResultMerger {
  private readonly best = new Map<string, SearchHit>();
  private readonly tombstones = new Map<string, number>();

  applyPage(page: SearchPage): void {
    for (const hit of page.hits) this.applyHit(hit);
  }

  applyHit(hit: SearchHit): void {
    if (hit.withdrawn) {
      const tomb = this.tombstones.get(hit.id);
      if (tomb === undefined || hit.version > tomb) {
        this.tombstones.set(hit.id, hit.version);
      }
      const current = this.best.get(hit.id);
      if (current !== undefined && current.version <= hit.version) {
        this.best.delete(hit.id);
      }
      return;
    }
    if (this.isTombstoned(hit.id, hit.version)) return;
    const current = this.best.get(hit.id);
    if (current === undefined || hit.version > current.version) {
      this.best.set(hit.id, hit);
    }
  }

  isTombstoned(id: string, version: number): boolean {
    const tomb = this.tombstones.get(id);
    return tomb !== undefined && version <= tomb;
  }

  get size(): number {
    return this.best.size;
  }

  /** Live hits sorted by score descending, then id ascending. */
  results(): SearchHit[] {
    return [...this.best.values()].sort(compareHits);
  }
}
