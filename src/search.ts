/**
 * Frontend search library: merges asynchronously arriving pages from multiple
 * sources into a single ranked, versioned result set.
 *
 * Semantics:
 * - Results are sorted by score descending, then id ascending.
 * - The same id may appear on several pages; the hit with the highest
 *   `version` wins. A hit flagged `withdrawn` forms a tombstone: it shadows
 *   every older version of that id and is excluded from the visible results.
 * - Each query has a generation token. `cancel()` (or starting a new query)
 *   invalidates the previous token, so late pages from an old query can never
 *   leak into the new one.
 */

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  readonly version: number;
  /** When true, this version withdraws the document (tombstone). */
  readonly withdrawn?: boolean;
}

export interface Page {
  /** Generation token returned by `beginQuery()`. */
  readonly queryId: number;
  /** Stable index of the page within its query, used for deduplication. */
  readonly pageIndex: number;
  readonly hits: readonly SearchHit[];
}

export interface MergedHit {
  readonly id: string;
  readonly score: number;
  readonly version: number;
}

export interface VersionEntry extends MergedHit {
  readonly withdrawn: boolean;
}

export type PageVerdict = "accepted" | "stale-query" | "duplicate-page";

interface MutableEntry {
  score: number;
  version: number;
  withdrawn: boolean;
}

export class SearchMerger {
  private generation = 0;
  private readonly table = new Map<string, MutableEntry>();
  private readonly seenPages = new Set<number>();

  /** Starts a new query, invalidating every previously issued token. */
  beginQuery(): number {
    this.generation += 1;
    this.table.clear();
    this.seenPages.clear();
    return this.generation;
  }

  /**
   * Cancels the in-flight query. Pages still travelling for it will be
   * rejected as `stale-query` when they arrive.
   */
  cancel(): void {
    this.generation += 1;
    this.table.clear();
    this.seenPages.clear();
  }

  /** Token of the query currently accepting pages. */
  get currentQuery(): number {
    return this.generation;
  }

  /**
   * Merges one asynchronously arrived page. Returns why it was or was not
   * applied so callers (and tests) can assert on stale-page rejection.
   */
  acceptPage(page: Page): PageVerdict {
    if (page.queryId !== this.generation) {
      return "stale-query";
    }
    if (this.seenPages.has(page.pageIndex)) {
      return "duplicate-page";
    }
    this.seenPages.add(page.pageIndex);
    for (const hit of page.hits) {
      const existing = this.table.get(hit.id);
      if (existing === undefined || hit.version > existing.version) {
        this.table.set(hit.id, {
          score: hit.score,
          version: hit.version,
          withdrawn: hit.withdrawn === true,
        });
      }
    }
    return "accepted";
  }

  /** Visible results: live entries sorted by score desc, then id asc. */
  results(): MergedHit[] {
    return this.sortedEntries()
      .filter((entry) => !entry.withdrawn)
      .map(({ id, score, version }) => ({ id, score, version }));
  }

  /** Withdrawn entries (tombstones), sorted like the visible results. */
  tombstones(): MergedHit[] {
    return this.sortedEntries()
      .filter((entry) => entry.withdrawn)
      .map(({ id, score, version }) => ({ id, score, version }));
  }

  /**
   * Snapshot of the full version table (live entries and tombstones alike),
   * sorted by id ascending. Tests compare this against an expected table.
   */
  versionTable(): VersionEntry[] {
    return [...this.table.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((a, b) => compareIds(a.id, b.id));
  }

  private sortedEntries(): VersionEntry[] {
    return [...this.table.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort(
        (a, b) => b.score - a.score || compareIds(a.id, b.id),
      );
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
