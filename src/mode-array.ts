/**
 * Persistent (versioned) mutable integer array with range-mode queries.
 *
 * - Every block update is atomic: it builds a fully-applied new version and
 *   appends it; the source version is never mutated.
 * - Old versions remain queryable forever (immutable snapshots).
 * - Range mode = most frequent value in [start, end); ties break to the
 *   smaller value. The query returns the value plus its frequency as
 *   evidence. Empty ranges return null.
 */

export interface ModeEvidence {
  /** The mode value inside the queried range. */
  value: number;
  /** How many times `value` occurs inside the queried range. */
  count: number;
}

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${name} must be an integer, got ${value}`);
  }
}

function assertRange(length: number, start: number, end: number): void {
  assertInteger(start, "start");
  assertInteger(end, "end");
  if (start < 0 || end > length || start > end) {
    throw new RangeError(
      `invalid range [${start}, ${end}) for array of length ${length}`,
    );
  }
}

export class PersistentModeArray {
  private readonly versions: Array<readonly number[]> = [];

  constructor(initial: readonly number[]) {
    for (const v of initial) assertInteger(v, "element");
    this.versions.push(Object.freeze(initial.slice()));
  }

  /** Number of versions (ids are 0 .. versionCount - 1). */
  get versionCount(): number {
    return this.versions.length;
  }

  /** Id of the most recent version. */
  get latestVersion(): number {
    return this.versions.length - 1;
  }

  /** Immutable snapshot of a version (throws on unknown version id). */
  snapshot(version: number): readonly number[] {
    const snap = this.versions[version];
    if (snap === undefined) {
      throw new RangeError(`unknown version ${version}`);
    }
    return snap;
  }

  /**
   * Atomic block update: set every index in [start, end) of `version` to
   * `value`, producing a new version. Returns the new version id.
   * The source version is left untouched and stays queryable.
   */
  replaceRange(
    version: number,
    start: number,
    end: number,
    value: number,
  ): number {
    const base = this.snapshot(version);
    assertRange(base.length, start, end);
    assertInteger(value, "value");
    const next = base.slice();
    next.fill(value, start, end); // applied in full before publish => atomic
    this.versions.push(Object.freeze(next));
    return this.versions.length - 1;
  }

  /**
   * Mode of [start, end) in the given version: highest frequency wins,
   * ties break to the smaller value. Returns null for an empty range.
   */
  queryMode(version: number, start: number, end: number): ModeEvidence | null {
    const snap = this.snapshot(version);
    assertRange(snap.length, start, end);
    if (start === end) return null;

    const freq = new Map<number, number>();
    let best: ModeEvidence | null = null;
    for (let i = start; i < end; i++) {
      const v = snap[i]!;
      const c = (freq.get(v) ?? 0) + 1;
      freq.set(v, c);
      if (best === null || c > best.count || (c === best.count && v < best.value)) {
        best = { value: v, count: c };
      }
    }
    return best;
  }
}
