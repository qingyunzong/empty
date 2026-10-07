export interface ConflictRecord {
  /** Sorted constraint ids participating in the conflict. */
  constraints: string[];
  /** Sorted assumption names participating in the conflict. */
  assumptions: string[];
  note: string;
}

export interface SourceUniverse {
  constraints: ReadonlySet<string>;
  assumptions: ReadonlySet<string>;
}

function coversAll(sources: readonly string[], active: ReadonlySet<string>): boolean {
  return sources.every((s) => active.has(s));
}

/**
 * Cache of minimal conflicts discovered by earlier solves. A cached
 * conflict may be reused only when every one of its sources (constraints
 * and assumptions) still exists in the current universe and is active;
 * retracting an assumption therefore silently invalidates exactly those
 * conflicts that mention it, without touching any others.
 */
export class ConflictCache {
  private records: ConflictRecord[];

  constructor(records: ConflictRecord[] = []) {
    this.records = records.map((r) => ({
      constraints: [...r.constraints].sort(),
      assumptions: [...r.assumptions].sort(),
      note: r.note,
    }));
  }

  static key(rec: Pick<ConflictRecord, "constraints" | "assumptions">): string {
    return `c:${[...rec.constraints].sort().join(",")}|a:${[...rec.assumptions].sort().join(",")}`;
  }

  /** Adds a conflict; returns false when an identical one is already cached. */
  add(rec: ConflictRecord): boolean {
    const normalized: ConflictRecord = {
      constraints: [...rec.constraints].sort(),
      assumptions: [...rec.assumptions].sort(),
      note: rec.note,
    };
    const key = ConflictCache.key(normalized);
    if (this.records.some((r) => ConflictCache.key(r) === key)) return false;
    this.records.push(normalized);
    return true;
  }

  /** All cached conflicts whose sources all still exist. */
  valid(universe: SourceUniverse): ConflictRecord[] {
    return this.records.filter(
      (r) =>
        coversAll(r.constraints, universe.constraints) && coversAll(r.assumptions, universe.assumptions)
    );
  }

  /**
   * Finds a cached conflict that proves the currently active source set
   * unsatisfiable: every source of the conflict must still exist and be
   * active. Returns undefined when no cached conflict applies.
   */
  findApplicable(active: SourceUniverse): ConflictRecord | undefined {
    return this.valid(active).find(
      (r) => coversAll(r.constraints, active.constraints) && coversAll(r.assumptions, active.assumptions)
    );
  }

  all(): ConflictRecord[] {
    return this.records.map((r) => ({
      constraints: [...r.constraints],
      assumptions: [...r.assumptions],
      note: r.note,
    }));
  }

  toJSON(): ConflictRecord[] {
    return this.all();
  }
}
